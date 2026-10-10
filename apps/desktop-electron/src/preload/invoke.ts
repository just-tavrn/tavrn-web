// SPDX-License-Identifier: Apache-2.0
/**
 * The bridge's methods over IPC: every method of a namespace (`src/shared/bridge.ts`) becomes a function that invokes
 * its channel and unwraps the main process's reply. A refusal rejects with the value the Tauri command would reject
 * with (an error code string or an object); a part of the shell that does not exist yet with
 * `Error("not implemented: <method>")`. `ipcRenderer` itself never reaches the page.
 */
import { ipcRenderer } from "electron";
import { BRIDGE_METHODS, channelOf, type BridgeNamespaceName, type IpcReply } from "../shared/bridge.ts";

async function invoke(namespace: string, method: string, args: unknown[]): Promise<unknown> {
  const reply = (await ipcRenderer.invoke(channelOf(namespace, method), ...args)) as IpcReply;
  if (reply.ok) return reply.value;
  if (reply.notImplemented) throw new Error(String(reply.error));
  throw reply.error;
}

/** The functions of one namespace of the bridge. */
export function namespace(name: BridgeNamespaceName): Readonly<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of BRIDGE_METHODS[name]) out[method] = (...args: unknown[]) => invoke(name, method, args);
  return Object.freeze(out);
}
