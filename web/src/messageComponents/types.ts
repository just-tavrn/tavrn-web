// SPDX-License-Identifier: Apache-2.0
/**
 * Message components (tavrn-protocol/APPLICATIONS.md §5.10, `components.v1`). TEMPORARY local copy of the contract
 * until @tavrn/sdk ships `components.ts`; replaced by re-exports from the sdk.
 */
export type ButtonStyle = "primary" | "secondary" | "success" | "danger" | "link";

export interface ComponentButton {
  type: "button";
  style: ButtonStyle;
  label: string;
  emoji?: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  default?: boolean;
}

export interface ComponentSelect {
  type: "select";
  custom_id: string;
  placeholder?: string;
  options: SelectOption[];
  min?: number;
  max?: number;
  disabled?: boolean;
}

export type Component = ComponentButton | ComponentSelect;

export interface ComponentRow {
  type: "row";
  components: Component[];
}

export interface ModalInput {
  custom_id: string;
  label: string;
  style: "short" | "paragraph";
  placeholder?: string;
  min_length?: number;
  max_length?: number;
  required?: boolean;
  value?: string;
}

export interface Modal {
  custom_id: string;
  title: string;
  inputs: ModalInput[];
}
