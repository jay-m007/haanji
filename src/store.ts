// Calls kept in one JSON file. Small on purpose: a factory gets tens of calls a day, not thousands.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Call } from "./agent.ts";

export class Store {
  private calls = new Map<string, Call>();
  private file: string;
  constructor(file: string) {
    this.file = file;
    if (existsSync(file)) {
      const list = JSON.parse(readFileSync(file, "utf8")) as Call[];
      for (const c of list) this.calls.set(c.id, c);
    }
  }
  get(id: string): Call | undefined { return this.calls.get(id); }
  list(): Call[] { return [...this.calls.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)); }
  put(c: Call): void { this.calls.set(c.id, c); this.save(); }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list(), null, 1));
    renameSync(tmp, this.file); // a crash mid-write never leaves half a file
  }
}
