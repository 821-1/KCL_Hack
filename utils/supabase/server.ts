import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    "https://bxghrwmehomismtnxuwz.supabase.co",
    "sb_publishable_jadiQT4P2AeAPyKWohW5-A_Z48fNuBv",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component からの呼び出し時は無視（今回はAPIルートなので問題なし）
          }
        },
      },
    }
  );
}