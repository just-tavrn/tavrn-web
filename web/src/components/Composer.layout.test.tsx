// SPDX-License-Identifier: Apache-2.0
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer: growth measurement", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads no layout when it renders again without focus (no forced reflow per conversation render)", () => {
    const { rerender } = render(<Composer placeholder="Nachricht" onSend={vi.fn()} />);
    const reads = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(40);
    for (let i = 0; i < 5; i++) rerender(<Composer placeholder="Nachricht" onSend={vi.fn()} above={<span>{i}</span>} />);
    expect(reads).not.toHaveBeenCalled();
  });
});
