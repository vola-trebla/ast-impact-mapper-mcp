export interface AffectedTestsResult {
  changed_files: string[];
  affected_tests: string[];
  total_affected: number;
}

export interface FileDependencies {
  file: string;
  imports: string[];
  imported_by: string[];
}

export interface ImpactExplanation {
  changed_file: string;
  test_file: string;
  found: boolean;
  import_chain: string[];
}

export interface CoverageGaps {
  uncovered_files: string[];
  total_source_files: number;
  total_uncovered: number;
  coverage_rate: number;
}

export interface TestSummary {
  total_source_files: number;
  total_test_files: number;
  covered_source_files: number;
  coverage_rate: number;
  most_imported_files: { file: string; imported_by_count: number }[];
  deepest_import_chains: { test: string; depth: number }[];
}

export interface RenameAwareDiffResult extends AffectedTestsResult {
  base_branch: string;
  renamed_files: Array<{ from: string; to: string; similarity: number }>;
}

export interface UnreachableModulesResult {
  unreachable_files: string[];
  entry_points_detected: string[];
  total_source_files: number;
  total_unreachable: number;
}

export interface CycleResult {
  chain: string[];
  severity: 'warning';
}

export interface ArchitecturalCyclesResult {
  cycles: CycleResult[];
  total_cycles: number;
  files_in_cycles: string[];
}

export interface TypeImpactFileResult {
  file: string;
  runtime_impact: boolean;
  reason: 'type_only_change' | 'runtime_logic_changed';
  affected_tests_must_run: string[];
  affected_tests_skippable: string[];
}

export interface DifferentiateTypeImpactResult {
  files: TypeImpactFileResult[];
  total_tests_must_run: number;
  total_tests_skippable: number;
}

export interface ApiMutation {
  export_name: string;
  kind: string;
  mutation_type: 'added' | 'removed' | 'signature_changed' | 'body_only';
  old_signature?: string;
  new_signature?: string;
}

export interface ApiSurfaceMutationResult {
  file: string;
  change_type: 'internal_refactor' | 'breaking_api_change';
  changed_signatures: ApiMutation[];
  affected_exports: string[];
}
