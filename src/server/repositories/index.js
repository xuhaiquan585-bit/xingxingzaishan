'use strict';

const { AccountRepository } = require('./accountRepository');
const { ArchiveRepository } = require('./archiveRepository');
const { AuditRepository } = require('./auditRepository');
const { CoCreationRepository } = require('./coCreationRepository');
const { IdentityRepository } = require('./identityRepository');
const { IdentityReferenceRepository } = require('./identityReferenceRepository');
const { LabelTemplateRepository } = require('./labelTemplateRepository');
const { OrderRepository } = require('./orderRepository');
const { OutboxRepository } = require('./outboxRepository');
const { PaymentRepository } = require('./paymentRepository');
const { ProofRepository } = require('./proofRepository');
const { PublicQrProvenanceRepository } = require('./publicQrProvenanceRepository');
const { QrBatchRepository } = require('./qrBatchRepository');
const { QrAdministrationRepository } = require('./qrAdministrationRepository');
const { QrIssuanceRepository } = require('./qrIssuanceRepository');
const { QrRepository } = require('./qrRepository');
const { RecordRepository } = require('./recordRepository');

module.exports = {
  AccountRepository,
  ArchiveRepository,
  AuditRepository,
  CoCreationRepository,
  IdentityRepository,
  IdentityReferenceRepository,
  LabelTemplateRepository,
  OrderRepository,
  OutboxRepository,
  PaymentRepository,
  ProofRepository,
  PublicQrProvenanceRepository,
  QrAdministrationRepository,
  QrBatchRepository,
  QrIssuanceRepository,
  QrRepository,
  RecordRepository
};
