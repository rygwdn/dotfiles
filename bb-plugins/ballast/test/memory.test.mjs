/**
 * The parsers, against real output.
 *
 * These fixtures are verbatim from the machine Ballast was written on, at the
 * moment it was holding 5.2 GB of swap while `memory_pressure` claimed 61%
 * free. That disagreement is the reason this module exists, so it is the case
 * the tests pin.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseKernelPressure,
  parseMeminfo,
  parseSwapUsage,
  parseVmStat,
  swapCounters,
} from "../lib/memory.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    11887.
Pages active:                                 467336.
Pages inactive:                               363803.
Pages speculative:                            102040.
Pages throttled:                                   0.
Pages wired down:                             196995.
Pages purgeable:                                1044.
"Translation faults":                     1179544352.
File-backed pages:                            264584.
Anonymous pages:                              668595.
Pages stored in compressor:                  1236954.
Pages occupied by compressor:                 388325.
Swapins:                                     1499821.
Swapouts:                                    2314393.
`;

test("parseVmStat reads the page size and every counter", () => {
  const { pageSize, pages } = parseVmStat(VM_STAT);
  assert.equal(pageSize, 16384);
  assert.equal(pages.get("pages free"), 11887);
  assert.equal(pages.get("pages wired down"), 196995);
  assert.equal(pages.get("pages occupied by compressor"), 388325);
  assert.equal(pages.get("anonymous pages"), 668595);
  // The quoted key must survive — it is quoted in real output.
  assert.equal(pages.get("translation faults"), 1179544352);
});

test("the derived numbers agree with what top reported at the same instant", () => {
  const { pageSize, pages } = parseVmStat(VM_STAT);
  const gib = (key) => (pages.get(key) * pageSize) / 1024 ** 3;
  // top said: 3069M wired, 6029M compressor.
  assert.ok(Math.abs(gib("pages wired down") - 3069 / 1024) < 0.05);
  assert.ok(Math.abs(gib("pages occupied by compressor") - 6029 / 1024) < 0.05);
});

test("swapCounters ignores file page-ins when swap is idle", () => {
  // A machine with no swap in use: Swapins is 0, Pageins is millions of file
  // faults. Falling back on Pageins graded this as 700 MB/min "from swap".
  const { pages } = parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pageins:                                     3769713.
Pageouts:                                      14878.
Swapins:                                           0.
Swapouts:                                          0.
`);
  assert.deepEqual(swapCounters(pages), { swapInPages: 0, swapOutPages: 0 });

  const { pages: busy } = parseVmStat(VM_STAT);
  assert.deepEqual(swapCounters(busy), { swapInPages: 1499821, swapOutPages: 2314393 });
});

test("parseSwapUsage handles the sysctl format and its units", () => {
  const swap = parseSwapUsage("total = 6144.00M  used = 5192.50M  free = 951.50M  (encrypted)");
  assert.equal(swap.totalBytes, 6144 * 1024 ** 2);
  assert.equal(swap.usedBytes, 5192.5 * 1024 ** 2);

  const big = parseSwapUsage("total = 16.00G  used = 2.50G  free = 13.50G");
  assert.equal(big.totalBytes, 16 * 1024 ** 3);
  assert.equal(big.usedBytes, 2.5 * 1024 ** 3);
});

test("parseKernelPressure maps the sysctl ladder, and refuses to guess", () => {
  assert.equal(parseKernelPressure("kern.memorystatus_vm_pressure_level: 1"), "normal");
  assert.equal(parseKernelPressure("kern.memorystatus_vm_pressure_level: 2"), "warn");
  assert.equal(parseKernelPressure("kern.memorystatus_vm_pressure_level: 4"), "critical");
  assert.equal(parseKernelPressure(""), null);
  assert.equal(parseKernelPressure("unknown oid"), null);
});

test("parseMeminfo converts kB to bytes", () => {
  const info = parseMeminfo(`MemTotal:       16384000 kB
MemFree:          524288 kB
MemAvailable:    4194304 kB
Cached:          2097152 kB
`);
  assert.equal(info.get("memtotal"), 16384000 * 1024);
  assert.equal(info.get("memavailable"), 4194304 * 1024);
});
