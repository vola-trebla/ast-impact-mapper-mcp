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
