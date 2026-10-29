// The control state (kill switch, approvals waiting, chats), shared by the sidebar, Inbox and composer.
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";

export function useControl() {
  return useQuery({ queryKey: ["control"], queryFn: api.control, refetchInterval: 30_000 });
}
