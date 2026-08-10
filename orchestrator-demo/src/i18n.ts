export type Lang = "ru" | "uz" | "en";

export const STRINGS: Record<Lang, Record<string, string>> = {
  ru: {
    subtitle: "Fleet Orchestrator — демо-симуляция",
    robots: "Роботы",
    orderRate: "Поток заказов",
    kpiTitle: "Показатели смены",
    kpiDone: "Заказов выполнено",
    kpiRate: "Заказов / час",
    kpiCycle: "Средний цикл, с",
    kpiUtil: "Загрузка флота",
    kpiDist: "Пробег, м",
    kpiQueue: "Очередь заказов",
    savedWalk: "Сэкономлено ходьбы персонала",
    feedTitle: "Заказы из 1C / WMS",
    fleetTitle: "Флот",
    footer: "Демо: назначение задач, маршрутизация A*, разрешение конфликтов, зарядка. Роботы — серийные AMR; платформа — Tez Robotics.",
    stIdle: "ожидает",
    stToPick: "едет за товаром",
    stCarry: "везёт заказ",
    stCharge: "зарядка",
    stNew: "новый",
    stAssigned: "в работе",
    stDone: "выполнен",
  },
  uz: {
    subtitle: "Fleet Orchestrator — demo simulyatsiya",
    robots: "Robotlar",
    orderRate: "Buyurtma oqimi",
    kpiTitle: "Smena ko'rsatkichlari",
    kpiDone: "Bajarilgan buyurtma",
    kpiRate: "Buyurtma / soat",
    kpiCycle: "O'rtacha tsikl, s",
    kpiUtil: "Flot bandligi",
    kpiDist: "Yurilgan yo'l, m",
    kpiQueue: "Buyurtma navbati",
    savedWalk: "Xodimlar yurishi tejaldi",
    feedTitle: "1C / WMS buyurtmalari",
    fleetTitle: "Flot",
    footer: "Demo: vazifa taqsimoti, A* marshrutlash, konflikt hal qilish, zaryadlash. Robotlar — seriyali AMR; platforma — Tez Robotics.",
    stIdle: "kutmoqda",
    stToPick: "tovarga ketmoqda",
    stCarry: "buyurtma olib ketmoqda",
    stCharge: "zaryadlanmoqda",
    stNew: "yangi",
    stAssigned: "ishda",
    stDone: "bajarildi",
  },
  en: {
    subtitle: "Fleet Orchestrator — demo simulation",
    robots: "Robots",
    orderRate: "Order rate",
    kpiTitle: "Shift metrics",
    kpiDone: "Orders completed",
    kpiRate: "Orders / hour",
    kpiCycle: "Avg cycle, s",
    kpiUtil: "Fleet utilization",
    kpiDist: "Distance, m",
    kpiQueue: "Order queue",
    savedWalk: "Staff walking saved",
    feedTitle: "Orders from 1C / WMS",
    fleetTitle: "Fleet",
    footer: "Demo: task allocation, A* routing, conflict resolution, charging. Robots are series AMRs; the platform is Tez Robotics.",
    stIdle: "idle",
    stToPick: "to pickup",
    stCarry: "carrying",
    stCharge: "charging",
    stNew: "new",
    stAssigned: "assigned",
    stDone: "done",
  },
};

let current: Lang = "ru";

export function setLang(l: Lang) {
  current = l;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n!;
    const s = STRINGS[l][key];
    if (s) el.textContent = s;
  });
}

export function t(key: string): string {
  return STRINGS[current][key] ?? key;
}

export function lang(): Lang {
  return current;
}
