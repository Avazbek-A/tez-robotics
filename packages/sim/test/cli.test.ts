import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("sim CLI arg parsing (hand-rolled, no yargs dep)", () => {
  it("parses --map and --robots, applying the default broker url", () => {
    const args = parseArgs(["--map", "maps/demo-grid.json", "--robots", "10"]);
    expect(args.map).toBe("maps/demo-grid.json");
    expect(args.robots).toBe(10);
    expect(args.broker).toBe("mqtt://localhost:1883");
    expect(args.failRobot).toEqual([]);
  });

  it("parses an explicit --broker override", () => {
    const args = parseArgs(["--map", "m.json", "--robots", "3", "--broker", "mqtt://example:1883"]);
    expect(args.broker).toBe("mqtt://example:1883");
  });

  it("parses a single --fail-robot <id>@<sec>", () => {
    const args = parseArgs(["--map", "m.json", "--robots", "5", "--fail-robot", "sim-003@30"]);
    expect(args.failRobot).toEqual([{ id: "sim-003", atSec: 30 }]);
  });

  it("accumulates repeated --fail-robot flags", () => {
    const args = parseArgs([
      "--map",
      "m.json",
      "--robots",
      "5",
      "--fail-robot",
      "sim-001@5",
      "--fail-robot",
      "sim-002@10",
    ]);
    expect(args.failRobot).toEqual([
      { id: "sim-001", atSec: 5 },
      { id: "sim-002", atSec: 10 },
    ]);
  });

  it("parses --interface-name and a valid --vda-version", () => {
    const args = parseArgs([
      "--map",
      "m.json",
      "--robots",
      "1",
      "--interface-name",
      "myiface",
      "--vda-version",
      "2.1.0",
    ]);
    expect(args.interfaceName).toBe("myiface");
    expect(args.vdaVersion).toBe("2.1.0");
  });

  it("throws when --map is missing", () => {
    expect(() => parseArgs(["--robots", "10"])).toThrow(/--map is required/);
  });

  it("throws when --robots is missing", () => {
    expect(() => parseArgs(["--map", "m.json"])).toThrow(/--robots is required/);
  });

  it("throws on a non-positive-integer --robots", () => {
    expect(() => parseArgs(["--map", "m.json", "--robots", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--map", "m.json", "--robots", "abc"])).toThrow(/positive integer/);
  });

  it("throws on a malformed --fail-robot value", () => {
    expect(() => parseArgs(["--map", "m.json", "--robots", "1", "--fail-robot", "sim-003"])).toThrow(
      /<id>@<sec>/
    );
    expect(() =>
      parseArgs(["--map", "m.json", "--robots", "1", "--fail-robot", "sim-003@notanumber"])
    ).toThrow(/non-negative number/);
  });

  it("throws on an invalid --vda-version", () => {
    expect(() =>
      parseArgs(["--map", "m.json", "--robots", "1", "--vda-version", "9.9.9"])
    ).toThrow(/--vda-version must be one of/);
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--bogus", "x"])).toThrow(/unknown argument/);
  });
});
