import { SearchClusterService } from './search-cluster'
export class OpenSearchService extends SearchClusterService {
  constructor() {
    super('opensearch')
  }
}
