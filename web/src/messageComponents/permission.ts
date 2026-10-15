// SPDX-License-Identifier: Apache-2.0
import { Permission } from "@tavrn/sdk";

/** Bit 40 `use_components` (tavrn-protocol/permissions.md): clicking, selecting and submitting modals. */
export const USE_COMPONENTS: bigint = (Permission as unknown as Record<string, bigint | undefined>).USE_COMPONENTS ?? 1n << 40n;
