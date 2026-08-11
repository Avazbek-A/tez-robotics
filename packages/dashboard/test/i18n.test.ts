import { beforeEach, describe, expect, it } from "vitest";
import { STRINGS, useI18n } from "../src/i18n";
import type { Lang } from "../src/i18n";

const LANGS: Lang[] = ["ru", "uz", "en"];

describe("i18n", () => {
  beforeEach(() => {
    localStorage.clear();
    useI18n.setState({ lang: "ru" });
  });

  it("all three langs have identical key sets", () => {
    const [ru, uz, en] = LANGS.map((l) => Object.keys(STRINGS[l]).sort());
    expect(uz).toEqual(ru);
    expect(en).toEqual(ru);
  });

  it("carries the new keys required for the dashboard shell", () => {
    const newKeys = [
      "tabCockpit",
      "tabOrders",
      "tabAnalytics",
      "alarms",
      "connection",
      "connected",
      "reconnecting",
      "orderId",
      "status",
      "robot",
      "battery",
      "queue",
      "searchOrders",
    ];
    for (const lang of LANGS) {
      for (const key of newKeys) {
        expect(STRINGS[lang]).toHaveProperty(key);
        expect(STRINGS[lang][key]).not.toBe("");
      }
    }
  });

  it("t() returns the translated string for the current lang", () => {
    useI18n.getState().setLang("en");
    expect(useI18n.getState().t("tabCockpit")).toBe(STRINGS.en.tabCockpit);
  });

  it("t() falls back to the key itself when missing", () => {
    const { t } = useI18n.getState();
    expect(t("__does_not_exist__")).toBe("__does_not_exist__");
  });

  it("setLang updates state and persists lang to localStorage", () => {
    useI18n.getState().setLang("uz");
    expect(useI18n.getState().lang).toBe("uz");

    const raw = localStorage.getItem("tez-dashboard-lang");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string);
    expect(parsed.state.lang).toBe("uz");
  });
});
