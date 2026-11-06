import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createClient();

    // 通常のルート・バス停座標を持つテーブル名のリスト
    const tableNames = [
      "shinai_2",
      "shinai_3",
      "kotake_1",
      "tento_21",
      "usui_27",
      "okuma_12",
      "kamiyamada_23",
      "limited",
    ]; 

    const promises = tableNames.map(async (tableName) => {
      const { data, error } = await supabase
        .from(tableName) 
        .select(`
          bus_route_type,
          bus_stop_number,
          point_types,
          bus_stops ( x_axis, y_axis ,bus_stop_name ) 
        `)
        .order("bus_route_type", { ascending: true })
        .order("id", { ascending: true });

      if (error) {
        console.error(`${tableName} の取得エラー:`, error);
        return [];
      }
      return (data || []).map((item: any) => ({ ...item, tableName }));
    });

    const results = await Promise.all(promises);
    const allData = results.flat();

    const groupedRoutes: Record<string, { table_name: string, bus_route_type: number | null, waypoints: any[] }> = {};    
    
    allData.forEach((item: any) => {
      const rId = `${item.tableName}_${item.bus_route_type}`;
      
      if (!groupedRoutes[rId]) {
        groupedRoutes[rId] = {
          table_name: item.tableName,
          bus_route_type: item.bus_route_type,
          waypoints: []
        };
      }      
      groupedRoutes[rId].waypoints.push({
        longitude: item.bus_stops?.x_axis,
        latitude: item.bus_stops?.y_axis,
        point_types: item.point_types,
        bus_stop_name:item.bus_stops?.bus_stop_name,
      });
    });
    
    const formattedData = Object.keys(groupedRoutes).map(key => ({
      route_id: key,
      table_name: groupedRoutes[key].table_name,
      bus_route_type: groupedRoutes[key].bus_route_type,
      waypoints: groupedRoutes[key].waypoints,
    }));

    return NextResponse.json(formattedData, { status: 200 });
  } catch (error) {
    console.error("Supabaseエラー:", error);
    return NextResponse.json(
      { error: "データの取得に失敗しました" },
      { status: 500 }
    );
  }
}