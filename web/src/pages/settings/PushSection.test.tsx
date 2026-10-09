// SPDX-License-Identifier: Apache-2.0
/** The push section of the notification settings: the report push switch and the hint about rooms on other nodes. */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { PushSection } from "./PushSection";
import { DEFAULT_SETTINGS, useNotifications } from "../../stores/notifications";
import { useLocale } from "../../i18n";
import { renderWithProviders } from "../../test/render";

beforeEach(() => {
  useLocale.setState({ locale: "en" });
  useNotifications.setState({ settings: DEFAULT_SETTINGS });
});

describe("PushSection", () => {
  it("reports push by default and the switch turns them off", async () => {
    renderWithProviders(<PushSection />);
    const toggle = screen.getByRole("checkbox", { name: /Push notifications for new reports/ });
    expect(toggle).toBeChecked();
    await userEvent.setup().click(toggle);
    expect(useNotifications.getState().settings.global.reports).toBe(false);
    expect(toggle).not.toBeChecked();
  });

  it("says that rooms on other nodes push only mentions, DMs and calls", () => {
    useLocale.setState({ locale: "de" });
    renderWithProviders(<PushSection />);
    expect(screen.getByTestId("push-remote-hint")).toHaveTextContent("In Räumen auf anderen Knoten");
  });
});
