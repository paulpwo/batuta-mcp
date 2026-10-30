import type { Json } from "./mcp-client.js";

/* A small, strict model of a Live set, answering the read commands the tool layer uses. */

export interface FakeParam { name: string; value: number; display: string; min?: number; max?: number }
export interface FakeDevice {
  name: string;
  params?: FakeParam[];
  chains?: Array<{ name: string; devices: FakeDevice[]; volumeDb?: number | null; volumeDisplay?: string }>;
  returnChains?: Array<{ name: string; devices: FakeDevice[] }>;
}
export interface FakeTrack { name: string; devices?: FakeDevice[]; group?: number | null; foldable?: boolean }

const DB_PER_RAW = 40;
/** Raw volume 0.85 is 0 dB; 1.0 is +6 dB. */
export function dbForRaw(raw: number): number { return (raw - 0.85) * DB_PER_RAW; }
export function rawForDb(db: number): number { return db / DB_PER_RAW + 0.85; }
export function fmtDb(db: number): string { return Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-inf dB"; }

export class FakeWorld {
  tracks: FakeTrack[] = [{ name: "Drums" }, { name: "Bass" }, { name: "Pad" }];
  returns: FakeTrack[] = [{ name: "A Reverb" }];
  scenes: string[] = ["Intro", "Verse", "Chorus"];
  masterName = "Master";
  /** Devices on the master track chain. */
  masterDevices: FakeDevice[] = [];
  /** Master cue volume in dB (or an unreadable display string); unset means the master reports no cue_volume. */
  cueDb: number | string | undefined = undefined;
  /** Cap on items per page, to force pagination. */
  maxPage = 500;
  tempo = 120;
  /** Mixer volume in dB by "track0" / "return0" / "master". Unset means 0 dB. */
  volumeDb: Record<string, number | string> = {};
  /** What `display_at_value` answers for a device parameter (default: the value followed by " dB"). */
  displayAt: (param: FakeParam, value: number) => string = (_p, value) => fmtDb(value);
  songInfoExtra: Json = {};
  calls: Array<{ cmd: string; args: Json }> = [];

  trackKey(ref: Json): string { return ref["kind"] === "master" ? "master" : `${String(ref["kind"])}${String(ref["index"])}`; }

  private page(items: Json[], args: Json): Json {
    const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
    const limit = Math.min(typeof args["limit"] === "number" ? args["limit"] : 100, this.maxPage);
    const stop = Math.min(items.length, offset + limit);
    return { items: items.slice(offset, stop), total: items.length, next_offset: stop < items.length ? stop : null };
  }

  trackInfos(args: Json): Json[] {
    const list: Json[] = [];
    const info = (t: FakeTrack, kind: string, index: number | null): Json => ({
      kind, index, name: t.name, color: 0, mute: false, solo: false, arm: false, can_be_armed: kind !== "master",
      has_midi_input: true, has_audio_input: false, is_foldable: t.foldable === true, fold_state: null,
      group_track_index: t.group ?? null, monitoring_state: 1, device_count: t.devices?.length ?? 0,
    });
    this.tracks.forEach((t, i) => list.push(info(t, "track", i)));
    if (args["include_returns"] !== false) this.returns.forEach((t, i) => list.push(info(t, "return", i)));
    if (args["include_master"] !== false) list.push(info({ name: this.masterName }, "master", null));
    return list;
  }

  devicesOf(trackRef: Json): FakeDevice[] {
    if (trackRef["kind"] === "track") return this.tracks[trackRef["index"] as number]?.devices ?? [];
    if (trackRef["kind"] === "return") return this.returns[trackRef["index"] as number]?.devices ?? [];
    if (trackRef["kind"] === "master") return this.masterDevices;
    return [];
  }

  /** Walk a path of hops; with `container` the last hop may name a chain. Returns the device list or the device. */
  locate(trackRef: Json, path: unknown[], container: boolean): FakeDevice[] | FakeDevice | undefined {
    let devices = this.devicesOf(trackRef);
    let current: FakeDevice | undefined;
    for (const [i, hop] of path.entries()) {
      if (typeof hop === "number") { current = devices[hop]; devices = current?.chains?.flatMap((c) => c.devices) ?? []; continue; }
      const h = hop as Json;
      const parent = current;
      if (h["chain"] !== undefined || h["return_chain"] !== undefined) {
        const chains = h["chain"] !== undefined ? parent?.chains : parent?.returnChains;
        const chain = chains?.[(h["chain"] ?? h["return_chain"]) as number];
        devices = chain?.devices ?? [];
        if (h["device"] === undefined) {
          if (!container || i !== path.length - 1) return undefined;
          return devices;
        }
        current = devices[h["device"] as number];
      }
    }
    return container ? devices : current;
  }

  paramInfos(device: FakeDevice): Json[] {
    return (device.params ?? []).map((p, index) => ({
      index, name: p.name, value: p.value, min: p.min ?? 0, max: p.max ?? 1, default: 0, display: p.display, is_quantized: false,
      value_items: null, is_enabled: true, automation_state: 0,
    }));
  }

  mixerDisplay(key: string): { display: string; db: number | null; raw: number } {
    const v = this.volumeDb[key] ?? 0;
    if (typeof v === "string") return { display: v, db: null, raw: 0 };
    return { display: fmtDb(v), db: v, raw: rawForDb(v) };
  }

  /** Answers for the read commands. Mutating commands get an empty ok result unless `intercept` handles them. */
  answers(): Record<string, (args: Json) => unknown> {
    const world = this;
    const log = (cmd: string, args: Json): void => { world.calls.push({ cmd, args }); };
    return {
      song_info: (args) => { log("song_info", args); return { tempo: world.tempo, track_count: world.tracks.length, return_count: world.returns.length, scene_count: world.scenes.length, pending_sweeps: 0, recent_sweeps: [], ...world.songInfoExtra }; },
      track_list: (args) => { log("track_list", args); return world.page(world.trackInfos(args), args); },
      scene_list: (args) => { log("scene_list", args); return world.page(world.scenes.map((name, index) => ({ index, name, color: 0, tempo: null, time_signature: null, is_triggered: false })), args); },
      device_list: (args) => {
        log("device_list", args);
        const container = args["container"] as Json;
        const found = world.locate(container["track"] as Json, container["path"] as unknown[], true);
        const devices = Array.isArray(found) ? found : [];
        return world.page(devices.map((d, index) => ({ path: [...(container["path"] as unknown[]), index], name: d.name, class_name: "Device", type: "audio_effect", is_active: true, can_have_chains: d.chains !== undefined, can_have_drum_pads: false, parameter_count: d.params?.length ?? 0 })), args);
      },
      rack_get: (args) => {
        log("rack_get", args);
        const dev = args["device"] as Json;
        const device = world.locate(dev["track"] as Json, dev["path"] as unknown[], false) as FakeDevice | undefined;
        const chainInfo = (c: { name: string; volumeDb?: number | null; volumeDisplay?: string }, index: number): Json => {
          const db = c.volumeDb === undefined ? 0 : c.volumeDb;
          return { index, name: c.name, color: 0, mute: false, solo: false, device_count: 0, volume: { value: 0.85, min: 0, max: 1, display: c.volumeDisplay ?? (db === null ? "?" : fmtDb(db)), volume_db: db }, pan: { value: 0, min: -1, max: 1, display: "C" } };
        };
        return { chains: (device?.chains ?? []).map(chainInfo), return_chains: (device?.returnChains ?? []).map(chainInfo), macro_count: 8, variation_count: 0, selected_variation: 0, can_have_drum_pads: false };
      },
      device_get: (args) => {
        log("device_get", args);
        const dev = args["device"] as Json;
        const device = world.locate(dev["track"] as Json, dev["path"] as unknown[], false) as FakeDevice | undefined;
        const all = device === undefined ? [] : world.paramInfos(device);
        const page = world.page(all, args);
        return { device: { path: dev["path"], name: device?.name }, parameters: page["items"], total: all.length, next_offset: page["next_offset"] };
      },
      param_get: (args) => {
        log("param_get", args);
        const param = args["param"] as Json;
        const atValue = args["at_value"];
        if (param["mixer"] === "volume") {
          const mixer = world.mixerDisplay(world.trackKey(param["track"] as Json));
          const out: Json = { index: 0, name: "Volume", value: mixer.raw, min: 0, max: 1, default: 0.85, display: mixer.display };
          if (typeof atValue === "number") out["display_at_value"] = fmtDb(dbForRaw(atValue));
          return out;
        }
        const dev = param["device"] as Json;
        const device = world.locate(dev["track"] as Json, dev["path"] as unknown[], false) as FakeDevice | undefined;
        const p = device?.params?.[param["index"] as number];
        if (p === undefined) return { index: param["index"], name: "?", value: 0, min: 0, max: 1, default: 0, display: "0", is_quantized: false, value_items: null, is_enabled: true, automation_state: 0 };
        const out: Json = { index: param["index"], name: p.name, value: p.value, min: p.min ?? 0, max: p.max ?? 1, default: 0, display: p.display, is_quantized: false, value_items: null, is_enabled: true, automation_state: 0 };
        if (typeof atValue === "number") out["display_at_value"] = world.displayAt(p, atValue);
        return out;
      },
      mixer_get: (args) => {
        log("mixer_get", args);
        const track = args["track"] as Json;
        const mixer = world.mixerDisplay(world.trackKey(track));
        const out: Json = { volume: { value: mixer.raw, min: 0, max: 1, display: mixer.display, volume_db: mixer.db }, pan: { value: 0, min: -1, max: 1, display: "C" }, sends: [] };
        if (track["kind"] === "master" && world.cueDb !== undefined) {
          out["cue_volume"] = { value: 0.85, min: 0, max: 1, display: typeof world.cueDb === "string" ? world.cueDb : fmtDb(world.cueDb) };
        }
        return out;
      },
    };
  }
}
