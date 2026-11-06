import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createClient();

    const tableNames = [
      "kotake_1_weekday",
      "shinai_2_weekday",
      "shinai_3_weekday",
      "okuma_12_weekday",
      "tento_21_weekday",
      "kamiyamada_23_weekday",
      "usui_27_weekday",
      "limited_weekday",
    ];
    
const promises = tableNames.map(async (tableName) => {
      const { data, error } = await supabase
        .from(tableName)
        .select(`
          id,
          bus_stop_number,
          bus_route_type,
          point_types,
          *,
          bus_stops ( x_axis, y_axis )
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

    // ルート（テーブル名 + bus_route_type）ごとにデータをグループ化する
    const groupedRoutes: Record<string, { table_name: string, bus_route_type: number | null, rows: any[] }> = {};

    allData.forEach((item: any) => {
      // get-route側と同じ命名規則でルートIDを生成
      const rId = `${item.tableName}_${item.bus_route_type}`;

      if (!groupedRoutes[rId]) {
        groupedRoutes[rId] = {
          table_name: item.tableName,
          bus_route_type: item.bus_route_type,
          rows: []
        };
      }
      groupedRoutes[rId].rows.push(item);
    });

    const formattedData = Object.keys(groupedRoutes).map(key => ({
      route_id: key,
      table_name: groupedRoutes[key].table_name,
      bus_route_type: groupedRoutes[key].bus_route_type,
      rows: groupedRoutes[key].rows,
    }));

    return NextResponse.json(formattedData, { status: 200 });
  } catch (error) {
    console.error("APIエラー:", error);
    return NextResponse.json({ error: "データの取得に失敗しました" }, { status: 500 });
  }
}