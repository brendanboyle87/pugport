import { diagnosticText, redactDiagnosticText, type DiagnosticInput } from '../shared/diagnostics';
import type { Notify } from './Workspace';

export async function copyDiagnosticInfo(input: DiagnosticInput, notify: Notify, details = '') {
  try {
    await navigator.clipboard.writeText(redactDiagnosticText(diagnosticText(input) + details));
    notify({ tone: 'success', message: '已复制，未发送任何信息。' });
    return true;
  } catch {
    notify({ tone: 'error', message: '无法复制诊断信息，请检查剪贴板权限后重试。' });
    return false;
  }
}
