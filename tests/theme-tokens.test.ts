import { describe, expect, it } from "vitest";
import { COLOR, GRADIENT } from "../src/cli/ui/theme.js";
import {
  DEFAULT_THEME_NAME,
  FG,
  THEMES,
  listThemeNames,
  resolveThemeName,
  setActiveTheme,
  themeTokens,
} from "../src/cli/ui/theme/tokens.js";

describe("theme tokens", () => {
  it("resolves missing, auto, and invalid names to the default theme", () => {
    expect(resolveThemeName()).toBe(DEFAULT_THEME_NAME);
    expect(resolveThemeName("auto")).toBe(DEFAULT_THEME_NAME);
    expect(resolveThemeName("unknown")).toBe(DEFAULT_THEME_NAME);
  });

  it("lists all registered themes", () => {
    expect(listThemeNames()).toEqual([
      "default",
      "dark",
      "light",
      "tokyo-night",
      "github-dark",
      "github-light",
      "high-contrast",
    ]);
  });

  it("provides complete token sets for every theme", () => {
    for (const name of listThemeNames()) {
      const theme = THEMES[name];
      expect(theme.fg.body).toBeTruthy();
      expect(theme.tone.brand).toBeTruthy();
      expect(theme.toneActive.brand).toBeTruthy();
      expect(theme.surface.bg).toBeTruthy();
      expect(theme.card.error.color).toBe(theme.tone.err);
      expect(theme.card.streaming.color).toBe(theme.tone.brand);
    }
  });

  it("returns theme tokens by resolved name", () => {
    expect(themeTokens("github-light")).toBe(THEMES["github-light"]);
    expect(themeTokens("bad-name")).toBe(THEMES.default);
  });

  it("keeps legacy token exports bound to the active theme", () => {
    const restore = setActiveTheme(THEMES["github-light"]);
    expect(FG.body).toBe(THEMES["github-light"].fg.body);
    expect(COLOR.primary).toBe(THEMES["github-light"].tone.brand);

    restore();
  });

  it("keeps legacy token exports object-compatible", () => {
    const restore = setActiveTheme(THEMES["github-light"]);

    expect(Object.keys(FG)).toEqual(Object.keys(THEMES["github-light"].fg));
    expect({ ...COLOR }).toMatchObject({ primary: THEMES["github-light"].tone.brand });
    expect(JSON.parse(JSON.stringify(COLOR))).toMatchObject({
      primary: THEMES["github-light"].tone.brand,
    });
    expect(Array.isArray(GRADIENT)).toBe(true);
    expect([...GRADIENT]).toEqual([
      THEMES["github-light"].tone.ok,
      THEMES["github-light"].tone.brand,
      THEMES["github-light"].tone.info,
      THEMES["github-light"].toneActive.brand,
      THEMES["github-light"].toneActive.violet,
      THEMES["github-light"].tone.accent,
      THEMES["github-light"].toneActive.accent,
      THEMES["github-light"].tone.err,
    ]);

    restore();
  });

  it("restores legacy token exports after scoped active theme cleanup", () => {
    const restoreDefault = setActiveTheme(THEMES.default);
    const restoreLight = setActiveTheme(THEMES["github-light"]);

    expect(FG.body).toBe(THEMES["github-light"].fg.body);
    restoreLight();
    expect(FG.body).toBe(THEMES.default.fg.body);
    restoreDefault();
  });
});
