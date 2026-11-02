import { redactSecrets } from '@agent-rail/core';
import type { FindingInput, Reviewer, ReviewInput, StructuredFindings } from './types.ts';

interface DebugRule {
  id: string;
  pattern: RegExp;
  reason: string;
  fix: string;
  appliesTo: RegExp;
}

const DEBUG_RULES: readonly DebugRule[] = [
  {
    id: 'debug.console',
    pattern: /\bconsole\.(log|debug|trace)\s*\(/,
    reason: 'Debug logging left in changed code',
    fix: 'Remove the statement or use the project logger.',
    appliesTo: /\.(m|c)?[jt]sx?$/,
  },
  {
    id: 'debug.debugger',
    pattern: /^\s*debugger\s*;?\s*$/,
    reason: 'debugger statement left in changed code',
    fix: 'Remove the debugger statement.',
    appliesTo: /\.(m|c)?[jt]sx?$/,
  },
  {
    id: 'debug.focused-test',
    pattern: /\b(it|test|describe)\.only\s*\(/,
    reason: 'Focused test disables the rest of the suite',
    fix: 'Remove `.only`.',
    appliesTo: /\.(m|c)?[jt]sx?$/,
  },
  {
    id: 'debug.breakpoint',
    pattern: /^\s*(breakpoint\(\)|import\s+pdb|pdb\.set_trace\(\))/,
    reason: 'Python breakpoint left in changed code',
    fix: 'Remove the breakpoint.',
    appliesTo: /\.py$/,
  },
  {
    id: 'debug.dbg-macro',
    pattern: /\bdbg!\s*\(/,
    reason: 'dbg! macro left in changed code',
    fix: 'Remove the dbg! invocation.',
    appliesTo: /\.rs$/,
  },
];

export class StaticAnalysisReviewer implements Reviewer {
  readonly identity = 'rail-static-analysis';
  readonly model = null;
  readonly promptVersion = 'static-1';

  async review(input: ReviewInput): Promise<StructuredFindings> {
    const findings: FindingInput[] = [];
    const focus = new Set(input.focusPaths);
    for (const file of input.files) {
      if (focus.size > 0 && !focus.has(file.path)) continue;
      for (const line of file.lines) {
        if (line.kind !== 'add') continue;
        if (redactSecrets(line.text).redactions > 0) {
          findings.push({
            ruleId: 'security.secret',
            severity: 'critical',
            confidence: 0.9,
            path: file.path,
            startLine: line.line,
            endLine: line.line,
            reason: 'Possible secret committed in source',
            evidence: redactSecrets(line.text).text.trim().slice(0, 200),
            suggestedFix: 'Remove the credential, rotate it, and load it from the secret store at runtime.',
          });
        }
        if (input.reviewType === 'security') continue;
        for (const rule of DEBUG_RULES) {
          if (rule.appliesTo.test(file.path) && rule.pattern.test(line.text)) {
            findings.push({
              ruleId: rule.id,
              severity: rule.id === 'debug.focused-test' ? 'high' : 'low',
              confidence: 0.8,
              path: file.path,
              startLine: line.line,
              endLine: line.line,
              reason: rule.reason,
              evidence: line.text.trim().slice(0, 200),
              suggestedFix: rule.fix,
            });
          }
        }
      }
    }
    if (input.reviewType !== 'code') {
      for (const cls of input.securityClasses) {
        findings.push({
          ruleId: `sensitive.${cls}`,
          severity: 'medium',
          confidence: 1,
          path: null,
          reason: `Change touches ${cls} paths and needs operator attention`,
          evidence: null,
          suggestedFix: null,
        });
      }
    }
    const blocking = findings.some((f) => f.severity === 'high' || f.severity === 'critical');
    return {
      verdict: blocking ? 'changes_requested' : 'passed',
      confidence: 0.9,
      summary: `${findings.length} finding(s) from static analysis`,
      findings,
    };
  }
}
