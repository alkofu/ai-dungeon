import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useDungeonSend(): { sendHi: () => Promise<string> } {
  const sendHi = useCallback(async () => invoke<string>("dungeon_send", { msg: "Hi" }), []);
  return { sendHi };
}
