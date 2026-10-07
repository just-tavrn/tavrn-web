// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Captcha } from "./Captcha";

describe("Captcha", () => {
  afterEach(() => {
    delete window.turnstile;
  });

  it("renders the widget with the site key and passes the token on", async () => {
    const render_ = vi.fn((_el: HTMLElement, opts: { callback: (t: string) => void }) => {
      setTimeout(() => opts.callback("tok-123"), 0);
      return "w1";
    });
    window.turnstile = { render: render_, reset: vi.fn(), remove: vi.fn() } as unknown as typeof window.turnstile;
    const onToken = vi.fn();
    const { rerender, unmount } = render(<Captcha siteKey="site" onToken={onToken} />);
    expect(screen.getByTestId("captcha")).toBeInTheDocument();
    await vi.waitFor(() => expect(onToken).toHaveBeenCalledWith("tok-123"));
    expect(render_.mock.calls[0]![1]).toMatchObject({ sitekey: "site" });
    rerender(<Captcha siteKey="site" onToken={onToken} resetKey={1} />);
    expect(window.turnstile!.reset).toHaveBeenCalledWith("w1");
    expect(onToken).toHaveBeenLastCalledWith(null);
    unmount();
    expect(window.turnstile!.remove).toHaveBeenCalledWith("w1");
  });
});
