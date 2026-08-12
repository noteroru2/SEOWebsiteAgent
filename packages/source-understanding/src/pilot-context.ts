import { getDatabase, opportunitySourceInput } from '@seo-agent/database';
import {
  buildSourceContext,
  inspectRepository,
  sourceEvidenceHash,
  type RouteMapping,
  type SourceContext,
} from './index';

const ids = process.argv.slice(2);
if (ids.length !== 3) throw new Error('Exactly three opportunity ids are required');
const { pool } = getDatabase();
try {
  const output = [];
  for (const id of ids) {
    const source = await opportunitySourceInput(id, pool);
    const state = await inspectRepository(String(source.repository.local_path));
    const contexts: SourceContext[] = [];
    for (const row of source.mappings) {
      const mapping: RouteMapping = {
        routePath: row.route_path,
        status: row.mapping_status,
        primarySourcePath: row.primary_source_path,
        relatedSourcePaths: row.related_source_paths ?? [],
        evidence: row.mapping_evidence ?? {},
      };
      contexts.push(await buildSourceContext(state, mapping));
    }
    const primaryPaths = contexts
      .map((item) => item.routeMapping.primarySourcePath)
      .filter(Boolean) as string[];
    const allFiles = contexts.flatMap((item) => item.files);
    const files = [
      ...primaryPaths.map((primary) => allFiles.find((file) => file.path === primary)!),
      ...allFiles,
    ]
      .filter(Boolean)
      .filter(
        (file, index, all) => all.findIndex((candidate) => candidate.path === file.path) === index,
      )
      .slice(0, 6);
    let remaining = 40_000;
    const bounded = files
      .map((file) => {
        const excerpt = file.excerpts[0]!;
        const text = excerpt.text.slice(0, remaining);
        remaining -= text.length;
        return { ...file, excerpts: [{ ...excerpt, text, endLine: text.split('\n').length }] };
      })
      .filter((file) => file.excerpts[0]!.text.length);
    const context: SourceContext = {
      repository: contexts[0]!.repository,
      routeMapping:
        contexts.length === 1
          ? contexts[0]!.routeMapping
          : {
              routePath: source.routes.join(' | '),
              status: 'MULTI_FILE_COMPOSITION',
              primarySourcePath: contexts[0]!.routeMapping.primarySourcePath,
              relatedSourcePaths: contexts
                .slice(1)
                .map((item) => item.routeMapping.primarySourcePath!)
                .filter(Boolean),
              evidence: { routes: source.routes },
            },
      files: bounded,
      totalCharacters: 40_000 - remaining,
      redactions: bounded.filter((file) => file.redacted).length,
    };
    output.push({
      id,
      kind: source.opportunity.kind,
      query: source.opportunity.query,
      routes: source.routes,
      files: context.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        lineCount: file.lineCount,
        excerptRanges: file.excerpts.map((excerpt) => [excerpt.startLine, excerpt.endLine]),
        excerptCharacters: file.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0),
        redacted: file.redacted,
      })),
      totalCharacters: context.totalCharacters,
      redactions: context.redactions,
      sourceEvidenceHash: sourceEvidenceHash({
        opportunityFingerprint: source.opportunity.fingerprint,
        batch5AnalysisId: source.batch5.analysis_id,
        context,
      }),
    });
  }
  process.stdout.write(JSON.stringify(output, null, 2));
} finally {
  await pool.end();
}
