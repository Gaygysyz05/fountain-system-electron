import { useEffect, useMemo, useRef, useState } from "react";
import { useTimelineStore } from "../../store/timelineStore";
import { generateValvePattern, defaultParametersFor } from "../../lib/scenario";
import type { DeviceType } from "../../lib/protocol";
import {
  getColorHex,
  getContrastTextClass,
  getNumber,
  isOn,
  parseClipboardToken,
  toClipboardToken,
  type DeviceColumn,
} from "./deviceColumns";
import { ContextMenu, type MenuSection } from "./ContextMenu";

interface Cell {
  row: number;
  col: number;
}

type Entry = { deviceId: string; time: number; parameters: Record<string, unknown> };

function rectOf(a: Cell, b: Cell): { rMin: number; rMax: number; cMin: number; cMax: number } {
  return { rMin: Math.min(a.row, b.row), rMax: Math.max(a.row, b.row), cMin: Math.min(a.col, b.col), cMax: Math.max(a.col, b.col) };
}

/**
 * Spreadsheet-style device table -- one instance per driver-instance sub-tab
 * (DeviceCategoryTabs.tsx), which sits under one category tab (Valves /
 * Motors / Nozzles / Light). ROWS = time steps, COLUMNS = devices/channels
 * -- component_tables.py's own layout. An earlier version of this table
 * transposed that (devices as rows) to avoid a wide table with many
 * channels, but a long scenario duration turns out to make time-as-columns
 * just as wide, so there was no real win -- reverted to match the
 * reference app exactly. Column layout comes from deviceColumns.ts;
 * everything else (rectangular drag-select, inline number editing, native
 * color picker, right-click bulk ops, Ctrl+C/Ctrl+V) is written once
 * against `col.kind` and shared across categories.
 */
export function DeviceTable({
  category,
  columns,
  rowTimes,
  getEffective,
  hasExplicit,
  isFlagged,
}: {
  category: DeviceType;
  columns: DeviceColumn[];
  rowTimes: number[];
  getEffective: (deviceId: string, timeIndex: number) => Record<string, unknown> | undefined;
  hasExplicit: (deviceId: string, timeIndex: number) => boolean;
  /** Optional: cell reads as "toggled faster than the hardware can take"
   * (see DeviceTablePanel.tsx's min_toggle_interval check) -- purely a
   * warning indicator, never blocks the edit. */
  isFlagged?: (deviceId: string, timeIndex: number) => boolean;
}): JSX.Element {
  const setGridEventsBulk = useTimelineStore((s) => s.setGridEventsBulk);
  const removeGridEventsBulk = useTimelineStore((s) => s.removeGridEventsBulk);

  const [selStart, setSelStart] = useState<Cell | null>(null);
  const [selEnd, setSelEnd] = useState<Cell | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [editingCell, setEditingCell] = useState<Cell | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [freqPromptOpen, setFreqPromptOpen] = useState(false);
  const [freqPromptValue, setFreqPromptValue] = useState("");
  const didDragRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const colorTargetRef = useRef<"cell" | "selection">("cell");
  const colorCellRef = useRef<Cell | null>(null);

  useEffect(() => {
    function onUp(): void {
      setIsSelecting(false);
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // Selection/edit state holds row/col indices into `rowTimes` and
  // `columns` -- if either array changes shape (devices added/removed,
  // sub-tab switched, time step size changed) a stale index can point past
  // the new array's end. Drop everything that's just an index into the old
  // shape rather than letting a render read `columns[outOfRangeIndex]` and
  // crash.
  useEffect(() => {
    setSelStart(null);
    setSelEnd(null);
    setEditingCell(null);
    setMenu(null);
  }, [columns, rowTimes]);

  const rect = selStart && selEnd ? rectOf(selStart, selEnd) : null;

  function isSelected(row: number, col: number): boolean {
    return !!rect && row >= rect.rMin && row <= rect.rMax && col >= rect.cMin && col <= rect.cMax;
  }

  function baseParams(deviceId: string, row: number): Record<string, unknown> {
    return { ...(getEffective(deviceId, row) ?? defaultParametersFor(category)) };
  }

  /** Every write below goes through this before hitting the store. Without
   * it, setting one cell relies on "state persists until changed" to show
   * up at all -- which also means it keeps showing at every later row that
   * has nothing of its own, i.e. one click paints the whole rest of the
   * column. This inserts a terminator row right after the edit, restoring
   * whatever was effectively there before, so an edit affects only the
   * rows it actually touched -- the dense, one-cell-at-a-time feel of
   * component_tables.py's spreadsheet, kept on top of sparse hold-until-
   * changed storage (which is what the daemon actually plays). */
  function capBleed(patchMap: Map<string, Entry>, maxRowByDevice: Map<string, number>): void {
    for (const [deviceId, maxRow] of maxRowByDevice) {
      const nextRow = maxRow + 1;
      if (nextRow >= rowTimes.length) continue;
      if (hasExplicit(deviceId, nextRow)) continue;
      const nextKey = `${deviceId}::${rowTimes[nextRow]}`;
      if (patchMap.has(nextKey)) continue;
      const preEdit = getEffective(deviceId, nextRow) ?? defaultParametersFor(category);
      const justSet = patchMap.get(`${deviceId}::${rowTimes[maxRow]}`)?.parameters;
      if (justSet && JSON.stringify(justSet) === JSON.stringify(preEdit)) continue;
      patchMap.set(nextKey, { deviceId, time: rowTimes[nextRow], parameters: { ...preEdit } });
    }
  }

  function touch(patchMap: Map<string, Entry>, maxRowByDevice: Map<string, number>, deviceId: string, row: number, patch: Record<string, unknown>): void {
    const key = `${deviceId}::${rowTimes[row]}`;
    const base = patchMap.get(key)?.parameters ?? baseParams(deviceId, row);
    patchMap.set(key, { deviceId, time: rowTimes[row], parameters: { ...base, ...patch } });
    maxRowByDevice.set(deviceId, Math.max(maxRowByDevice.get(deviceId) ?? -1, row));
  }

  function commit(deviceId: string, row: number, patch: Record<string, unknown>): void {
    const patchMap = new Map<string, Entry>();
    const maxRowByDevice = new Map<string, number>();
    touch(patchMap, maxRowByDevice, deviceId, row, patch);
    capBleed(patchMap, maxRowByDevice);
    setGridEventsBulk([...patchMap.values()]);
  }

  function handleMouseDown(row: number, col: number, e: React.MouseEvent): void {
    if (e.button !== 0) return;
    containerRef.current?.focus();
    didDragRef.current = false;
    setSelStart({ row, col });
    setSelEnd({ row, col });
    setIsSelecting(true);
  }

  function handleMouseEnter(row: number, col: number): void {
    if (!isSelecting) return;
    if (selStart && (selStart.row !== row || selStart.col !== col)) didDragRef.current = true;
    setSelEnd({ row, col });
  }

  function handleClick(row: number, col: number): void {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    const column = columns[col];
    if (column.kind === "toggle") {
      commit(column.deviceId, row, { [column.field]: !isOn(getEffective(column.deviceId, row), column) });
    } else if (column.kind === "number") {
      setEditingCell({ row, col });
    } else {
      colorTargetRef.current = "cell";
      colorCellRef.current = { row, col };
      if (colorInputRef.current) {
        colorInputRef.current.value = getColorHex(getEffective(column.deviceId, row));
        colorInputRef.current.click();
      }
    }
  }

  /** Click a column header / row time-label to select the whole
   * column/row in one action -- dragging through 30+ rows by hand to
   * select one channel's whole timeline was the alternative. */
  function selectColumn(col: number): void {
    containerRef.current?.focus();
    setSelStart({ row: 0, col });
    setSelEnd({ row: rowTimes.length - 1, col });
  }

  function selectRow(row: number): void {
    containerRef.current?.focus();
    setSelStart({ row, col: 0 });
    setSelEnd({ row, col: columns.length - 1 });
  }

  function handleContextMenu(row: number, col: number, e: React.MouseEvent): void {
    e.preventDefault();
    if (!isSelected(row, col)) {
      setSelStart({ row, col });
      setSelEnd({ row, col });
    }
    setMenu({ x: e.clientX, y: e.clientY });
  }

  function commitNumberEdit(row: number, col: number, text: string): void {
    const column = columns[col];
    const n = parseFloat(text);
    setEditingCell(null);
    if (Number.isNaN(n)) return;
    const clamped = Math.max(column.min ?? -Infinity, Math.min(column.max ?? Infinity, n));
    commit(column.deviceId, row, { [column.field]: clamped });
  }

  function forEachSelected(kind: DeviceColumn["kind"], fn: (row: number, col: DeviceColumn) => void): void {
    if (!rect) return;
    for (let r = rect.rMin; r <= rect.rMax; r++) {
      for (let c = rect.cMin; c <= rect.cMax; c++) {
        const column = columns[c];
        if (column.kind === kind) fn(r, column);
      }
    }
  }

  function copySelection(): void {
    if (!rect) return;
    const lines: string[] = [];
    for (let r = rect.rMin; r <= rect.rMax; r++) {
      const cells: string[] = [];
      for (let c = rect.cMin; c <= rect.cMax; c++) {
        const column = columns[c];
        cells.push(toClipboardToken(getEffective(column.deviceId, r), column));
      }
      lines.push(cells.join("\t"));
    }
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  }

  async function pasteSelection(): Promise<void> {
    if (!rect) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text.trim()) return;
    const rows = text.replace(/\r/g, "").split("\n").filter((_, i, arr) => !(i === arr.length - 1 && arr[i] === ""));
    const patchMap = new Map<string, Entry>();
    const maxRowByDevice = new Map<string, number>();

    rows.forEach((line, dr) => {
      const targetRow = rect.rMin + dr;
      if (targetRow >= rowTimes.length) return;
      line.split("\t").forEach((cellText, dc) => {
        const targetCol = rect.cMin + dc;
        if (targetCol >= columns.length) return;
        const column = columns[targetCol];
        const patch = parseClipboardToken(cellText, column);
        if (!patch) return;
        touch(patchMap, maxRowByDevice, column.deviceId, targetRow, patch);
      });
    });

    capBleed(patchMap, maxRowByDevice);
    if (patchMap.size > 0) setGridEventsBulk([...patchMap.values()]);
  }

  function setSelectedToggle(value: boolean): void {
    const patchMap = new Map<string, Entry>();
    const maxRowByDevice = new Map<string, number>();
    forEachSelected("toggle", (row, column) => touch(patchMap, maxRowByDevice, column.deviceId, row, { [column.field]: value }));
    capBleed(patchMap, maxRowByDevice);
    if (patchMap.size > 0) setGridEventsBulk([...patchMap.values()]);
  }

  function applyPatternToSelection(pattern: "alternate"): void {
    if (!rect) return;
    const toggleCols = columns.slice(rect.cMin, rect.cMax + 1).filter((c) => c.kind === "toggle");
    if (toggleCols.length === 0) return;
    const startTime = rowTimes[rect.rMin];
    const endTime = rowTimes[rect.rMax];
    const stepInterval = rowTimes.length > 1 ? Math.max(0.1, rowTimes[1] - rowTimes[0]) : 1;
    const field = toggleCols[0].field;
    const generated = generateValvePattern({
      deviceIds: toggleCols.map((c) => c.deviceId),
      startTime,
      endTime,
      stepInterval,
      pattern,
    });
    const patchMap = new Map<string, Entry>();
    const maxRowByDevice = new Map<string, number>();
    for (const { time, device_id, on } of generated) {
      const rowIndex = rowTimes.findIndex((t) => t === time);
      if (rowIndex < 0) continue;
      touch(patchMap, maxRowByDevice, device_id, rowIndex, { [field]: on });
    }
    capBleed(patchMap, maxRowByDevice);
    if (patchMap.size > 0) setGridEventsBulk([...patchMap.values()]);
  }

  // Electron's renderer doesn't implement window.prompt() (unlike
  // alert()/confirm(), which it backs with a native dialog) -- it's a
  // silent no-op that always returns null, so the old
  // `window.prompt("Frequency...")` here never showed anything and every
  // click looked like it did nothing. A small in-app modal instead.
  function openFrequencyPrompt(): void {
    const numberCols = rect ? columns.slice(rect.cMin, rect.cMax + 1).filter((c) => c.kind === "number") : [];
    if (numberCols.length === 0) return;
    setFreqPromptValue("");
    setFreqPromptOpen(true);
  }

  function applyFrequencyPrompt(): void {
    const n = parseFloat(freqPromptValue);
    setFreqPromptOpen(false);
    if (Number.isNaN(n)) return;
    const patchMap = new Map<string, Entry>();
    const maxRowByDevice = new Map<string, number>();
    forEachSelected("number", (row, column) => {
      const clamped = Math.max(column.min ?? -Infinity, Math.min(column.max ?? Infinity, n));
      touch(patchMap, maxRowByDevice, column.deviceId, row, { [column.field]: clamped });
    });
    capBleed(patchMap, maxRowByDevice);
    if (patchMap.size > 0) setGridEventsBulk([...patchMap.values()]);
  }

  function setSelectedColor(): void {
    colorTargetRef.current = "selection";
    if (colorInputRef.current) {
      colorInputRef.current.value = "#ffffff";
      colorInputRef.current.click();
    }
  }

  function onColorInputChange(hex: string): void {
    const n = parseInt(hex.slice(1), 16);
    const rgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    if (colorTargetRef.current === "cell" && colorCellRef.current) {
      const column = columns[colorCellRef.current.col];
      commit(column.deviceId, colorCellRef.current.row, rgb);
    } else {
      const patchMap = new Map<string, Entry>();
      const maxRowByDevice = new Map<string, number>();
      forEachSelected("color", (row, column) => touch(patchMap, maxRowByDevice, column.deviceId, row, rgb));
      capBleed(patchMap, maxRowByDevice);
      if (patchMap.size > 0) setGridEventsBulk([...patchMap.values()]);
    }
  }

  function clearSelected(): void {
    if (!rect) return;
    const seen = new Set<string>();
    const entries: Array<{ deviceId: string; time: number }> = [];
    for (let r = rect.rMin; r <= rect.rMax; r++) {
      for (let c = rect.cMin; c <= rect.cMax; c++) {
        const column = columns[c];
        const key = `${column.deviceId}::${rowTimes[r]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ deviceId: column.deviceId, time: rowTimes[r] });
      }
    }
    removeGridEventsBulk(entries);
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.ctrlKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelection();
    } else if (e.ctrlKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void pasteSelection();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      clearSelected();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const cur = selEnd ?? { row: 0, col: 0 };
      let { row, col } = cur;
      if (e.key === "ArrowUp") row = Math.max(0, row - 1);
      else if (e.key === "ArrowDown") row = Math.min(rowTimes.length - 1, row + 1);
      else if (e.key === "ArrowLeft") col = Math.max(0, col - 1);
      else if (e.key === "ArrowRight") col = Math.min(columns.length - 1, col + 1);
      setSelStart({ row, col });
      setSelEnd({ row, col });
    } else if (e.key === "Enter" && selEnd && !editingCell) {
      e.preventDefault();
      handleClick(selEnd.row, selEnd.col);
    }
  }

  const selectedKinds = useMemo(() => {
    if (!rect) return new Set<DeviceColumn["kind"]>();
    const kinds = new Set<DeviceColumn["kind"]>();
    for (let c = rect.cMin; c <= rect.cMax; c++) kinds.add(columns[c].kind);
    return kinds;
  }, [rect, columns]);

  const menuSections: MenuSection[] = menu
    ? [
        [
          { label: "Copy", onClick: copySelection },
          { label: "Paste", onClick: () => void pasteSelection() },
        ],
        ...(selectedKinds.has("toggle")
          ? [
              [
                { label: `Set Selected: ${columns.find((c) => c.kind === "toggle")?.onLabel ?? "On"}`, onClick: () => setSelectedToggle(true) },
                { label: `Set Selected: ${columns.find((c) => c.kind === "toggle")?.offLabel ?? "Off"}`, onClick: () => setSelectedToggle(false) },
                { label: "Apply Pattern: Alternate", onClick: () => applyPatternToSelection("alternate") },
              ],
            ]
          : []),
        ...(selectedKinds.has("number") ? [[{ label: "Set Frequency for Selected…", onClick: openFrequencyPrompt }]] : []),
        ...(selectedKinds.has("color") ? [[{ label: "Set Color for Selected…", onClick: setSelectedColor }]] : []),
        [{ label: "Clear Selected", onClick: clearSelected, danger: true }],
      ]
    : [];

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="relative overflow-auto outline-none"
    >
      <input
        ref={colorInputRef}
        type="color"
        className="absolute h-0 w-0 opacity-0"
        onChange={(e) => onColorInputChange(e.target.value)}
      />
      <table className="border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 border border-border bg-bg-surface1 px-sm py-1 text-text-muted">t (s)</th>
            {columns.map((col, col_i) => (
              <th
                key={col.key}
                title={`${col.title} -- click to select the whole channel`}
                onClick={() => selectColumn(col_i)}
                className="sticky top-0 z-10 cursor-pointer whitespace-nowrap border border-border bg-bg-surface1 px-sm py-1 font-medium text-text-secondary hover:bg-bg-surface2"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowTimes.map((time, row) => (
            <tr key={time}>
              <td
                title="Click to select the whole row"
                onClick={() => selectRow(row)}
                className="sticky left-0 z-10 cursor-pointer border border-border bg-bg-surface1 px-sm py-1 text-text-muted hover:bg-bg-surface2"
              >
                {time}
              </td>
              {columns.map((column, col) => {
                const params = getEffective(column.deviceId, row);
                const selected = isSelected(row, col);
                const editing = editingCell?.row === row && editingCell?.col === col;
                let content: JSX.Element;
                let extraClass = "";

                if (column.kind === "toggle") {
                  // on-color is per column (green for an open valve or a
                  // running motor -- "1"/active reads as go), not the
                  // daemon's own accent blue, which reads as "selected UI
                  // element" rather than "live output".
                  const on = isOn(params, column);
                  const onBg = column.onColor === "success" ? "bg-success" : "bg-danger";
                  extraClass = on ? `${onBg} text-white` : "bg-bg-surface2 text-text-disabled";
                  content = <>{on ? "1" : "0"}</>;
                } else if (column.kind === "number") {
                  extraClass = "bg-bg-surface2 text-text-secondary";
                  content = editing ? (
                    <input
                      type="number"
                      autoFocus
                      defaultValue={getNumber(params, column)}
                      min={column.min}
                      max={column.max}
                      step={column.step}
                      onBlur={(e) => commitNumberEdit(row, col, e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitNumberEdit(row, col, (e.target as HTMLInputElement).value);
                        if (e.key === "Escape") setEditingCell(null);
                      }}
                      className="w-16 border-0 bg-transparent text-center text-xs text-text-primary outline-none"
                    />
                  ) : (
                    <>{getNumber(params, column).toFixed(1)}</>
                  );
                } else {
                  const hex = getColorHex(params);
                  extraClass = getContrastTextClass(hex);
                  content = (
                    <span className="inline-block w-full rounded px-1" style={{ backgroundColor: hex }}>
                      {hex}
                    </span>
                  );
                }

                const flagged = isFlagged?.(column.deviceId, row) ?? false;

                return (
                  <td
                    key={column.key}
                    onMouseDown={(e) => handleMouseDown(row, col, e)}
                    onMouseEnter={() => handleMouseEnter(row, col)}
                    onClick={() => handleClick(row, col)}
                    onContextMenu={(e) => handleContextMenu(row, col, e)}
                    title={flagged ? "Toggled faster than this relay's minimum toggle interval allows" : undefined}
                    className={`relative cursor-pointer select-none whitespace-nowrap border px-sm py-1 text-center font-medium ${extraClass} ${
                      selected ? "border-accent ring-2 ring-inset ring-accent" : "border-border"
                    } hover:brightness-110`}
                  >
                    {content}
                    {flagged && <span className="absolute right-0 top-0 h-0 w-0 border-b-[6px] border-l-[6px] border-b-transparent border-l-warning" />}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {menu && <ContextMenu x={menu.x} y={menu.y} sections={menuSections} onClose={() => setMenu(null)} />}

      {freqPromptOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setFreqPromptOpen(false)}
        >
          <div
            className="flex w-72 flex-col gap-sm rounded-panel border border-border bg-bg-surface1 p-md shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-text-primary">Frequency (Hz) for selected cells</div>
            <input
              type="number"
              step={0.1}
              autoFocus
              value={freqPromptValue}
              onChange={(e) => setFreqPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFrequencyPrompt();
                if (e.key === "Escape") setFreqPromptOpen(false);
              }}
              className="h-input rounded-control border border-border bg-bg-surface3 px-sm text-sm text-text-primary focus:border-accent focus:outline-none"
            />
            <div className="flex justify-end gap-sm">
              <button
                onClick={() => setFreqPromptOpen(false)}
                className="h-control rounded-control border border-border bg-bg-surface3 px-md text-sm text-text-primary hover:bg-bg-surface2"
              >
                Cancel
              </button>
              <button
                onClick={applyFrequencyPrompt}
                className="h-control rounded-control bg-primary px-md text-sm text-text-primary hover:bg-primary-hover"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
