import { cpus } from 'node:os';
import { shortHardwareName } from '../../shared/hardware-name.ts';
import { currentHost, type Host } from './host.ts';

export type CpuHardware = { model: string; cores?: number; threads: number };
export type GpuHardware = { name: string; luid?: string; memoryBytes?: number };
export type Hardware = { cpu: CpuHardware; gpus: GpuHardware[]; inventoryFailed?: boolean };

// DXGI exposes the same LUID as GPU Engine counters; CIM's enumeration order does not.
const windowsHardwareCommand = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class PugPortAdapters {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Desc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Name;
    public uint Vendor, Device, Subsys, Revision;
    public UIntPtr Video, System, Shared;
    public uint Low; public int High; public uint Flags;
  }
  public class Adapter { public string name; public string luid; public ulong memoryBytes; }
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAdapter(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDesc(IntPtr self, out Desc desc);
  public static Adapter[] Read() {
    var result = new List<Adapter>();
    var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    IntPtr factory;
    Marshal.ThrowExceptionForHR(CreateDXGIFactory1(ref iid, out factory));
    try {
      var table = Marshal.ReadIntPtr(factory);
      var enumerate = (EnumAdapter)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, 12 * IntPtr.Size), typeof(EnumAdapter));
      for (uint i = 0; ; i++) {
        IntPtr adapter;
        int hr = enumerate(factory, i, out adapter);
        if (hr == unchecked((int)0x887A0002)) break;
        Marshal.ThrowExceptionForHR(hr);
        try {
          var get = (GetDesc)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(adapter), 10 * IntPtr.Size), typeof(GetDesc));
          Desc desc; Marshal.ThrowExceptionForHR(get(adapter, out desc));
          if ((desc.Flags & 2) == 0) result.Add(new Adapter { name = desc.Name, memoryBytes = desc.Video.ToUInt64(), luid = "luid_0x" + unchecked((uint)desc.High).ToString("x8") + "_0x" + desc.Low.ToString("x8") });
        } finally { Marshal.Release(adapter); }
      }
    } finally { Marshal.Release(factory); }
    return result.ToArray();
  }
}
'@
$cores = (Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum
$gpus = @()
try { $gpus = @([PugPortAdapters]::Read()) } catch { $gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{name=$_.Name} }) }
@{cores=$cores; gpus=$gpus} | ConvertTo-Json -Depth 4 -Compress
`;

export function physicalAdapters(value: unknown): GpuHardware[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row.name !== 'string' || !shortHardwareName(row.name)) return [];
    return [
      {
        ...(Number.isFinite(row.memoryBytes) && row.memoryBytes >= 0 ? { memoryBytes: row.memoryBytes } : {}),
        name: row.name.trim(),
        ...(typeof row.luid === 'string' ? { luid: row.luid.toLowerCase() } : {}),
      },
    ];
  });
}

const cache = new WeakMap<Host, Promise<Hardware>>();
const expires = new WeakMap<Host, number>();
/** Daily inventory per host, including failed lookups; utilization samples reuse it. */
export function readHardware(host: Host = currentHost(), readCpus = cpus): Promise<Hardware> {
  const cached = cache.get(host);
  if (cached && Date.now() < (expires.get(host) ?? 0)) return cached;
  const pending = (async () => {
    const processors = readCpus();
    const hardware: Hardware = { cpu: { model: processors[0]?.model ?? '', threads: processors.length }, gpus: [] };
    try {
      if (host.platform === 'win32') {
        const { stdout } = await host.run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', windowsHardwareCommand],
          { timeout: 10_000, windowsHide: true },
        );
        const data = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (Number.isSafeInteger(data.cores) && data.cores > 0) hardware.cpu.cores = data.cores;
        hardware.gpus = physicalAdapters(data.gpus);
      } else if (host.platform === 'darwin') {
        const { stdout } = await host.run(
          '/bin/sh',
          ['-c', '/usr/sbin/sysctl -n hw.physicalcpu; /usr/sbin/system_profiler SPDisplaysDataType -json'],
          { timeout: 10_000 },
        );
        const newline = stdout.indexOf('\n');
        const cores = Number(stdout.slice(0, newline));
        if (Number.isSafeInteger(cores) && cores > 0) hardware.cpu.cores = cores;
        const data = JSON.parse(stdout.slice(newline + 1));
        hardware.gpus = physicalAdapters(
          (data.SPDisplaysDataType ?? []).map((gpu: { sppci_model?: string }) => ({ name: gpu.sppci_model })),
        );
      } else {
        const info = host.fs.readFileSync('/proc/cpuinfo', 'utf8');
        const cores = new Set(
          info.split(/\n\s*\n/).flatMap((block) => {
            const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
            const socket = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
            return core === undefined ? [] : [`${socket ?? '0'}:${core}`];
          }),
        );
        if (cores.size) hardware.cpu.cores = cores.size;
        const { stdout } = await host.run('lspci', [], { timeout: 3000 });
        hardware.gpus = physicalAdapters(
          stdout.split(/\r?\n/).flatMap((line) => {
            const name = /(?:VGA compatible controller|3D controller|Display controller):\s*(.*)/i.exec(line)?.[1];
            return name
              ? [
                  {
                    name: name
                      .replace(/\s*\(rev .*$/, '')
                      .replace(/\bCorporation\b|(?:,\s*)?\bInc\b\.?|\bCo\.,?\s*Ltd\.?|\[AMD\/ATI\]/gi, '')
                      .replace(
                        /^(Intel|NVIDIA|AMD|Advanced Micro Devices)\b.*\[([^\[\]]+)\]\s*$/i,
                        (_, vendor: string, product: string) =>
                          `${/^Advanced Micro Devices$/i.test(vendor) ? 'AMD' : vendor} ${product.split('/')[0].trim()}`,
                      )
                      .replace(/\s+/g, ' ')
                      .trim(),
                  },
                ]
              : [];
          }),
        );
      }
    } catch {
      hardware.inventoryFailed = true;
      // Keep the OS model/thread count even when optional inventory tools are unavailable.
    }
    return hardware;
  })();
  expires.set(host, Date.now() + 86400000);
  cache.set(host, pending);
  return pending;
}
