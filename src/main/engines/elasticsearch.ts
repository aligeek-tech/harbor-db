import { SearchClusterService } from './search-cluster'
export class ElasticsearchService extends SearchClusterService {
  constructor() {
    super('elasticsearch')
  }
}
