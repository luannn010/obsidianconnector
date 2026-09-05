export interface ParsedSequenceFlow {
  name: string;
  domain: string;
  status: string;
  participants: Array<{ alias: string; label: string }>;
  steps: Array<{
    source: string;
    target: string;
    message: string;
    response: boolean;
  }>;
}

export function parseSequenceFlows(markdown: string): ParsedSequenceFlow[] {
  const lines = markdown.split(/\r?\n/u);
  const flows: ParsedSequenceFlow[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.trim() !== 'sequenceDiagram') continue;
    let heading = 'Unnamed flow';
    let status = 'needs_review';
    for (let scan = index - 1; scan >= 0; scan--) {
      const statusMatch = lines[scan]!.match(/^Status:\s*\*\*([^*]+)\*\*/iu);
      if (statusMatch)
        status = statusMatch[1]!.trim().toLowerCase().replaceAll(' ', '_');
      const headingMatch = lines[scan]!.match(/^##+\s+(.+)$/u);
      if (headingMatch) {
        heading = headingMatch[1]!.trim();
        break;
      }
    }
    const participants: ParsedSequenceFlow['participants'] = [];
    const steps: ParsedSequenceFlow['steps'] = [];
    for (
      index++;
      index < lines.length && !lines[index]!.startsWith('```');
      index++
    ) {
      const participant = lines[index]!.match(
        /^\s*(?:actor|participant)\s+(\S+)(?:\s+as\s+(.+))?$/u,
      );
      if (participant) {
        participants.push({
          alias: participant[1]!,
          label: (participant[2] ?? participant[1])!.trim(),
        });
        continue;
      }
      const step = lines[index]!.match(
        /^\s*(\S+?)\s*(-{1,2}>>?)\s*(\S+?)\s*:\s*(.+)$/u,
      );
      if (step)
        steps.push({
          source: step[1]!,
          target: step[3]!,
          message: step[4]!.trim(),
          response: step[2]!.startsWith('--'),
        });
    }
    flows.push({
      name: heading,
      domain: heading.replace(/\s+flow$/iu, '').trim(),
      status,
      participants,
      steps,
    });
  }
  return flows;
}
