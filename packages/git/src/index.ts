export interface GitService {
  status(repositoryPath: string): Promise<readonly string[]>;
}
