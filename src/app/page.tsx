"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

interface RouteData {
  route_id: string | number;
  table_name: string;
  bus_route_type: number | null; 
  waypoints: { 
    latitude: number | string; 
    longitude: number | string; 
    point_types?: number | string | null;
    bus_stop_name?: string | null;
  }[];
}

interface RouteLists {
  route_types_number: number;
  starting_stop: string | null; 
  last_stop: string | null; 
  waypoints: string | null;
  bus_number: string | null;
  route_name: string | null;
}

const timeToSeconds = (timeStr: string) => {
  const [h, m, s = 0] = timeStr.split(":").map(Number);
  return h * 3600 + m * 60 + s;
};

let globalBusMarkers: maplibregl.Marker[] = [];
let globalTimers: NodeJS.Timeout[] = [];
let cachedForceData: any[] = []; 

const fetchWaypointsFromDB = async (): Promise<RouteData[]> => {
  const response = await fetch('/api/get-route');
  if (!response.ok) {
    throw new Error("データベースからのルート取得に失敗しました");
  }
  return await response.json();
};

export default function MapPage() {
  const [isListOpen, setIsListOpen] = useState(false);
  const [routeList, setRouteList] = useState<RouteLists[]>([]); 
  const [currentTimeStr, setCurrentTimeStr] = useState<string>("");

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const fetchAndRunBus = async (map: maplibregl.Map) => {
    try {
      globalTimers.forEach(t => clearInterval(t));
      globalTimers = [];
      globalBusMarkers.forEach(m => m.remove());
      globalBusMarkers = [];

      try {
        const forceRes = await fetch('/api/get-force');
        if (forceRes.ok) {
          cachedForceData = await forceRes.json();
        }
      } catch (err) {
        console.error("forceデータ取得失敗:", err);
      }

      const res = await fetch('/api/get-trip');
      if (!res.ok) throw new Error("時刻データの取得に失敗しました");
      
      const routeGroups: any[] = await res.json();
      if (routeGroups.length === 0) return;

      for (const group of routeGroups) {
        const rows = group.rows;
        if (!rows || rows.length === 0) continue;

        const firstRow = rows[0];
        const tripColumns = Object.keys(firstRow).filter(key => key.startsWith("col_"));
        if (tripColumns.length === 0) continue;

        // 1. 路線全体のバス停座標を取得し、OSRMで道路に沿った詳細ルート座標（routeCoords）を取得
        const validRows = rows.filter((p: any) => p.bus_stops);
        const stopCoords = validRows.map((p: any) => [Number(p.bus_stops.x_axis), Number(p.bus_stops.y_axis)]);
        if (stopCoords.length < 2) continue;

        const coordsString = stopCoords.map((c: any) => `${c[0]},${c[1]}`).join(";");
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;
        
        let routeCoords = stopCoords;
        try {
          const osrmRes = await fetch(osrmUrl);
          const osrmData = await osrmRes.json();
          if (osrmData.code === "Ok" && osrmData.routes.length > 0) {
            routeCoords = osrmData.routes[0].geometry.coordinates;
          }
        } catch (e) {
          console.error("OSRM取得エラー(バス):", e);
        }

        const routeIdStr = String(group.route_id || "").toLowerCase();
        const isLimitedRoute = routeIdStr.includes("limited");

        tripColumns.forEach((tripId, index) => {
          // 各便の有効な時刻とバス停情報を抽出
          const tripPoints = rows.map((r: any, rIndex: number) => ({
            rowIndex: rIndex,
            timeStr: r[tripId] || null,
            timeSec: r[tripId] ? timeToSeconds(r[tripId]) : null,
            coord: r.bus_stops ? [Number(r.bus_stops.x_axis), Number(r.bus_stops.y_axis)] : null,
            bus_stop_name: r.bus_stops?.bus_stop_name || "バス停"
          })).filter((p: any) => p.coord !== null && p.timeSec !== null);

          if (tripPoints.length < 2) return;

          const startPoint = tripPoints[0];
          const endPoint = tripPoints[tripPoints.length - 1];

          const startSec = startPoint.timeSec;
          const endSec = endPoint.timeSec;

          const tripStartTime = startPoint.timeStr;
          const tripEndTime = endPoint.timeStr;
          const tripStartStopName = startPoint.bus_stop_name;
          const tripEndStopName = endPoint.bus_stop_name;

          let busMarker: maplibregl.Marker | null = null;
          const colors = ["#ff5252", "#4caf50", "#ff9800", "#9c27b0", "#00bcd4", "#3887be"];
          const busColor = colors[index % colors.length];

          const timer = setInterval(() => {
            const now = new Date();
            now.setHours(now.getHours() - 12); // 12時間前シミュレーション

            const currentSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

            // 運行時間外ならマーカーを削除
            if (currentSec < startSec || currentSec > endSec) {
              if (busMarker) {
                busMarker.remove();
                busMarker = null;
              }
              return;
            }

            // === 2. 各バス停に対応するOSRMのルート座標上のインデックス（距離的近さ）を対応付け、道路に沿って動かす ===
            let currentLngLat: [number, number] | null = null;

            for (let i = 0; i < tripPoints.length - 1; i++) {
              const pA = tripPoints[i];
              const pB = tripPoints[i + 1];

              if (currentSec >= pA.timeSec && currentSec <= pB.timeSec) {
                const segmentDuration = pB.timeSec - pA.timeSec;
                const segmentProgress = segmentDuration > 0 ? (currentSec - pA.timeSec) / segmentDuration : 0;

                // バス停Aとバス停Bに最も近いOSRMルート上のインデックスをそれぞれ探す
                const findNearestRouteIndex = (targetCoord: [number, number]) => {
                  let minDist = Infinity;
                  let minIdx = 0;
                  for (let idx = 0; idx < routeCoords.length; idx++) {
                    const rc = routeCoords[idx];
                    const dist = Math.hypot(rc[0] - targetCoord[0], rc[1] - targetCoord[1]);
                    if (dist < minDist) {
                      minDist = dist;
                      minIdx = idx;
                    }
                  }
                  return minIdx;
                };

                const indexA = findNearestRouteIndex(pA.coord);
                const indexB = findNearestRouteIndex(pB.coord);

                // OSRMの道路に沿った区間内で、現在の進捗度に応じた位置を特定
                const routeIndexFloat = indexA + (indexB - indexA) * segmentProgress;
                const lowerIdx = Math.floor(routeIndexFloat);
                const upperIdx = Math.min(lowerIdx + 1, routeCoords.length - 1);
                const subRatio = routeIndexFloat - lowerIdx;

                const c1 = routeCoords[lowerIdx] || routeCoords[indexA];
                const c2 = routeCoords[upperIdx] || routeCoords[indexB];

                if (c1 && c2) {
                  const curLng = c1[0] + (c2[0] - c1[0]) * subRatio;
                  const curLat = c1[1] + (c2[1] - c1[1]) * subRatio;
                  currentLngLat = [curLng, curLat];
                }
                break;
              }
            }

            if (!currentLngLat) {
              if (busMarker) {
                busMarker.remove();
                busMarker = null;
              }
              return;
            }

            if (!busMarker) {
              const el = document.createElement('div');
              el.className = 'bus-marker';
              el.style.width = '40px';
              el.style.height = '40px';
              el.style.cursor = 'pointer';

              const iconImg = document.createElement('img');
              iconImg.src = isLimitedRoute ? '/limited_bus.png' : '/bus.png'; 
              iconImg.style.width = '100%';
              iconImg.style.height = '100%';
              iconImg.style.objectFit = 'contain';
              iconImg.style.filter = 'drop-shadow(0px 2px 4px rgba(0,0,0,0.4))';

              el.appendChild(iconImg);

              el.addEventListener('click', (e) => {
                e.stopPropagation();
                const parts = tripId.split('_'); 
                const middleNum = parts.length > 1 ? Number(parts[1]) : null;
                const matchedRoute = cachedForceData.find(r => Number(r.id) === Number(middleNum));

                const routeName = matchedRoute?.route_name || group.route_id;
                const busNumber = matchedRoute?.number || null; 
                const lastStop = matchedRoute?.last_stop || tripEndStopName;   
                const waypoints = matchedRoute?.via || null;       

                const popupContent = `
                  <div style="font-size: 12px; line-height: 1.4; max-width: 220px;">
                    <strong>運行バス情報</strong><br>
                    ${busNumber ? `<strong>行先番号:</strong> ${busNumber}<br>` : ""}
                    ${lastStop ? `<strong>終点:</strong> ${lastStop}<br>` : ""}
                    ${waypoints ? `<strong>経由地:</strong><br><div style="max-height: 50px; overflow-y: auto;">${String(waypoints).replace(/[,，]/g, "<br>")}</div>` : ""}
                  </div>
                `;

                if (busMarker) {
                  const lngLat = busMarker.getLngLat();
                  new maplibregl.Popup()
                    .setLngLat(lngLat)
                    .setHTML(popupContent)
                    .addTo(map);
                }
              });

              busMarker = new maplibregl.Marker({ element: el })
                .setLngLat(currentLngLat)
                .addTo(map);
              
              globalBusMarkers.push(busMarker);
            } else {
              busMarker.setLngLat(currentLngLat);
            }
          }, 1000);

          globalTimers.push(timer);
        });
      }
    } catch (e) {
      console.error("全バスのアニメーション実行エラー:", e);
    }
  };

  useEffect(() => {
    const clockTimer = setInterval(() => {
      const now = new Date();
      now.setHours(now.getHours() - 12);

      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      const s = String(now.getSeconds()).padStart(2, '0');
      setCurrentTimeStr(`${h}:${m}:${s}`);
    }, 1000);

    return () => clearInterval(clockTimer);
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    mapRef.current = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          "osm-tiles": {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "&copy; OpenStreetMap contributors",
            maxzoom: 19,
          },
        },
        layers: [
          {
            id: "osm-tiles-layer",
            type: "raster",
            source: "osm-tiles",
          },
        ],
      },
      center: [130.6911, 33.6466],
      zoom: 14,
      maxZoom: 19,
    });

    const map = mapRef.current;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    const drawMultipleRoutes = async (routes: RouteData[]) => {
      const LINE_COLORS = ["#3887be", "#9c27b0","#ffff00", "#4caf50", "#ff9800", "#00bcd4","#00ff00", "#ff5252"];
      const tableColorMap: Record<string, string> = {};
      let colorIndex = 0;

      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        const coords = route.waypoints.map(pt => [Number(pt.longitude), Number(pt.latitude)]);
        if (coords.length < 2) continue;

        if (!tableColorMap[route.table_name]) {
          tableColorMap[route.table_name] = LINE_COLORS[colorIndex % LINE_COLORS.length];
          colorIndex++;
        }
        
        const lineColor = tableColorMap[route.table_name];
        const coordsString = coords.map(c => `${c[0]},${c[1]}`).join(";");
        const url = `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;

        const sourceId = `route-source-${route.route_id}`;
        const layerId = `route-layer-${route.route_id}`;

        try {
          const response = await fetch(url);
          const data = await response.json();
          let routeGeometry = (data.code === "Ok" && data.routes.length > 0) ? data.routes[0].geometry : { type: "LineString", coordinates: coords };

          map.addSource(sourceId, { type: "geojson", data: { type: "Feature", properties: {}, geometry: routeGeometry } as any });
          map.addLayer({ id: layerId, type: "line", source: sourceId, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": lineColor, "line-width": 5, "line-opacity": 0.8 } });

          // === バス停（point_types !== 0）を個別の .png マーカーとして配置する ===
          route.waypoints.forEach((pt) => {
            // point_types が 0（通過点等）の場合はバス停アイコンを表示しない
            if (pt.point_types === 0) return;

            const lng = Number(pt.longitude);
            const lat = Number(pt.latitude);
            const stopName = pt.bus_stop_name || "バス停";

            // バス停用マーカーのHTML要素を作成
            const el = document.createElement('div');
            el.className = 'bus-stop-marker';
            el.style.width = '40px';
            el.style.height = '40px';
            el.style.cursor = 'pointer';

            const iconImg = document.createElement('img');
            iconImg.src = '/bus_stop.png'; 
            iconImg.style.width = '100%';
            iconImg.style.height = '100%';
            iconImg.style.objectFit = 'contain';
            iconImg.style.filter = 'drop-shadow(0px 1px 3px rgba(0,0,0,0.3))';

            el.appendChild(iconImg);

            // クリック時のポップアップ
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              const popupContent = `<div><strong>バス停情報</strong><br>${stopName}</div>`;
              new maplibregl.Popup()
                .setLngLat([lng, lat])
                .setHTML(popupContent)
                .addTo(map);
            });

            // MapLibreのMarkerとしてマップに追加
            new maplibregl.Marker({ element: el })
              .setLngLat([lng, lat])
              .addTo(map);
          });

        } catch (error) {
          console.error(`ルート描画エラー:`, error);
        }
      }
    };

    map.on("load", async () => {
      try {
        const dbRoutes = await fetchWaypointsFromDB();
        await drawMultipleRoutes(dbRoutes);
        await fetchAndRunBus(map);
      } catch (error) {
        console.error("初期化エラー:", error);
      }
    });

    const fetchList = async () => {
      try {
        const listResponse = await fetch('/api/get-list');
        if (listResponse.ok) {
          setRouteList(await listResponse.json());
        }
      } catch (error) {
        console.error("リスト取得エラー:", error);
      }
    };

    fetchList(); 

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      
      <div
        style={{
          position: "absolute",
          top: "15px",
          left: "15px",
          backgroundColor: "rgba(255, 255, 255, 0.9)",
          padding: "8px 14px",
          borderRadius: "6px",
          boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
          fontSize: "14px",
          fontWeight: "bold",
          color: "#333",
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          gap: "6px"
        }}
      >
        <span style={{ width: "8px", height: "8px", backgroundColor: "#ff9800", borderRadius: "50%", display: "inline-block" }}></span>
        シミュレーション時刻 (-12h): {currentTimeStr || "読み込み中..."}
      </div>

      {isListOpen && (
        <div
          style={{
            position: "absolute",
            bottom: "80px",
            right: "5px",
            width: "97%",
            backgroundColor: "white",
            borderRadius: "8px",
            boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
            zIndex: 10,
            padding: "15px",
            display: "flex",
            flexDirection: "column"
          }}
        >
          <h3 style={{ margin: "0 0 10px 0", borderBottom: "1px solid #ccc", paddingBottom: "5px" }}>
            ルートリスト
          </h3>
          <div style={{ maxHeight: "300px", overflowX: "auto", overflowY: "auto", borderBottom: "1px solid #ddd" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
              <thead>
                <tr>
                  <th style={{ position: "sticky", top: 0, backgroundColor: "#f5f5f5", zIndex: 1, padding: "8px", border: "1px solid #ddd", whiteSpace: "nowrap" }}>路線名</th>
                  <th style={{ position: "sticky", top: 0, backgroundColor: "#f5f5f5", zIndex: 1, padding: "8px", border: "1px solid #ddd", whiteSpace: "nowrap" }}>行先番号</th>
                  <th style={{ position: "sticky", top: 0, backgroundColor: "#f5f5f5", zIndex: 1, padding: "8px", border: "1px solid #ddd", whiteSpace: "nowrap" }}>始発</th>
                  <th style={{ position: "sticky", top: 0, backgroundColor: "#f5f5f5", zIndex: 1, padding: "8px", border: "1px solid #ddd" }}>経由地</th>
                  <th style={{ position: "sticky", top: 0, backgroundColor: "#f5f5f5", zIndex: 1, padding: "8px", border: "1px solid #ddd", whiteSpace: "nowrap" }}>終点</th>
                </tr>
              </thead>
              <tbody>
                {routeList.map((row, index) => (
                  <tr key={index}>
                    <td style={{ padding: "8px", border: "1px solid #ddd", whiteSpace: "nowrap" }}>{row.route_name}</td>
                    <td style={{ padding: "8px", border: "1px solid #ddd", whiteSpace: "nowrap" }}>{row.bus_number}</td>
                    
                    <td style={{ padding: "8px", border: "1px solid #ddd", whiteSpace: "nowrap" }}>
                      {row.starting_stop ? (
                        row.starting_stop.split(/[,，]/).map((point: string, i: number) => (
                          <div key={i}>{point.trim()}</div>
                        ))
                      ) : (
                        ""
                      )}
                    </td>

                    <td style={{ padding: "8px", border: "1px solid #ddd" }}>
                      {row.waypoints ? (
                        row.waypoints.split(/[,，]/).map((point: string, i: number) => (
                          <div key={i}>{point.trim()}</div>
                        ))
                      ) : (
                        ""
                      )}
                    </td>

                    <td style={{ padding: "8px", border: "1px solid #ddd", whiteSpace: "nowrap" }}>
                      {row.last_stop ? (
                        row.last_stop.split(/[,，]/).map((point: string, i: number) => (
                          <div key={i}>{point.trim()}</div>
                        ))
                      ) : (
                        ""
                      )}
                    </td>                 
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <button
        onClick={() => setIsListOpen(!isListOpen)}
        style={{
          position: "absolute",
          bottom: "20px",
          right: "20px",
          width: "50px",
          height: "50px",
          borderRadius: "50%",
          backgroundColor: "#3887be",
          color: "white",
          border: "none",
          fontSize: "20px",
          cursor: "pointer",
          boxShadow: "0 4px 6px rgba(0,0,0,0.3)",
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {isListOpen ? "▼" : "▲"}
      </button>
    </div>      
  );
}