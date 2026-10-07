// SPDX-License-Identifier: Apache-2.0
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNode } from "../components/NodeScope";
import { useThreads } from "./store";

/** Loads the user's followed threads of a room (PROTOCOL.md §7e) into the thread store while the room is open. */
export function useFollowedThreads(roomId: string) {
  const { api, domain } = useNode();
  const followed = useQuery({ queryKey: ["followed-threads", domain, roomId], queryFn: () => api.threads.followed(roomId), enabled: !!roomId, staleTime: 60_000 });
  useEffect(() => {
    if (followed.data) useThreads.getState().seedRoom(roomId, followed.data.items);
  }, [roomId, followed.data]);
}
