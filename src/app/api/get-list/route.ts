import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createClient();

    // 取得したい複数の曜日別テーブル名のリスト
    const tableNames = [
      "bus_route_lists",
    ];

    // すべてのテーブルに対して同時にクエリを投げる
    const promises = tableNames.map(async (tableName) => {
      const { data, error } = await supabase
        .from(tableName)
        .select(`*`)
        .order("id", { ascending: true });

      if (error) {
        console.error(`${tableName} の取得エラー:`, error);
        return [];
      }
      
      //どのテーブルのデータか分かるように table_name を付与
      return (data || []).map((item: any) => ({ ...item, tableName }));
    });

    // すべてのクエリ結果を並行して待機
    const results = await Promise.all(promises);
    const allTripData = results.flat(); // 1つの配列に結合

    return NextResponse.json(allTripData, { status: 200 });
  } catch (error) {
    console.error("APIエラー:", error);
    return NextResponse.json({ error: "データの取得に失敗しました" }, { status: 500 });
  }
}