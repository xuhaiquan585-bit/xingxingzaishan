'use strict';

function migrationSetMatches(applied, expected) {
  if (!Array.isArray(applied) || !Array.isArray(expected) || applied.length !== expected.length) {
    return false;
  }
  return expected.every((migration, index) => (
    applied[index]
    && applied[index].version === migration.version
    && applied[index].checksum === migration.checksum
  ));
}

async function checkCandidateFreshness({ provenanceRepository, sourceHash, migrations }) {
  const importRun = await provenanceRepository.findPassedImportBySourceHash(sourceHash);
  if (!importRun) {
    const latest = await provenanceRepository.findLatestPassedImport();
    return latest ? 'STALE_SOURCE' : 'INELIGIBLE_NO_IMPORT';
  }
  const appliedMigrations = await provenanceRepository.listAppliedMigrations();
  if (appliedMigrations.length === 0) return 'INELIGIBLE_NO_VERSION';
  return migrationSetMatches(appliedMigrations, migrations)
    ? 'ELIGIBLE'
    : 'INELIGIBLE_VERSION';
}

async function checkPublicQrDomainFreshness({
  provenanceRepository,
  domainHash,
  migrations
}) {
  const importRun = await provenanceRepository
    .findPassedImportByPublicQrDomainHash(domainHash);
  if (!importRun) {
    const latest = await provenanceRepository.findLatestPassedImport();
    return latest ? 'STALE_SOURCE' : 'INELIGIBLE_NO_IMPORT';
  }
  const appliedMigrations = await provenanceRepository.listAppliedMigrations();
  if (appliedMigrations.length === 0) return 'INELIGIBLE_NO_VERSION';
  return migrationSetMatches(appliedMigrations, migrations)
    ? 'ELIGIBLE'
    : 'INELIGIBLE_VERSION';
}

module.exports = {
  checkCandidateFreshness,
  checkPublicQrDomainFreshness,
  migrationSetMatches
};
