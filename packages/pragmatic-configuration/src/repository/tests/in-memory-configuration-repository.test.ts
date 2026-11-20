import { InMemoryConfigurationRepository } from '../in-memory-configuration-repository.js';
import { ConfigurationRepositoryConformance } from './configuration-repository-conformance.js';

ConfigurationRepositoryConformance.Register('InMemoryConfigurationRepository', clock => Promise.resolve(new InMemoryConfigurationRepository(clock)));
