import type {
  AuditFlag,
  ExtractionConfidence,
  PaymentStatus,
  SourceFormat,
  StoredInvoice,
  StoredLineItem,
  ValidatedInvoice,
} from '../../audit/types.js';
import type {
  CanonicalInvoice,
  InvoiceCategory,
  LineType,
  ReadingType,
} from '../../extraction/schema.js';
import type { Queryable } from '../pool.js';

export interface InsertInvoicePayload {
  validated: ValidatedInvoice;
  effectiveReadingType: ReadingType;
  paymentStatus: PaymentStatus;
  auditFlags: AuditFlag[];
}

export interface InvoiceRepository {
  findBySha256(fileSha256: string, db?: Queryable): Promise<StoredInvoice | null>;
  findById(invoiceId: number, db?: Queryable): Promise<StoredInvoice | null>;
  findLatestForConsumptionPoint(
    providerCui: string,
    consumptionPointId: string,
    db?: Queryable,
  ): Promise<StoredInvoice | null>;
  findRecentRealInvoices(
    providerCui: string,
    consumptionPointId: string,
    limit?: number,
    db?: Queryable,
  ): Promise<StoredInvoice[]>;
  findRecentEstimatedInvoicesSinceLastReal(
    providerCui: string,
    consumptionPointId: string,
    limit?: number,
    db?: Queryable,
  ): Promise<StoredInvoice[]>;
  findUnpaidOrHeld(db?: Queryable): Promise<StoredInvoice[]>;
  findAll(db?: Queryable): Promise<StoredInvoice[]>;
  insertInvoiceWithLines(payload: InsertInvoicePayload, db?: Queryable): Promise<StoredInvoice>;
  updatePaymentStatus(
    invoiceId: number,
    status: PaymentStatus,
    db?: Queryable,
  ): Promise<StoredInvoice | null>;
}

interface InvoiceRow {
  id: string;
  gmail_message_id: string | null;
  file_sha256: string;
  source_format: SourceFormat;
  provider_cui: string;
  provider_name: string;
  category: InvoiceCategory;
  client_code: string | null;
  consumption_point_id: string;
  invoice_series: string | null;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  billing_period_start: string | null;
  billing_period_end: string | null;
  billing_days: number;
  reading_type: ReadingType;
  old_index: string | null;
  new_index: string | null;
  consumption_value: string | null;
  consumption_unit: string | null;
  self_reading_window_start: number | null;
  self_reading_window_end: number | null;
  total_amount_cents: string;
  currency: string;
  extraction_confidence: ExtractionConfidence;
  payment_status: PaymentStatus;
  audit_flags: AuditFlag[];
  raw_extracted_json: CanonicalInvoice;
  created_at: Date;
}

interface LineItemRow {
  id: string;
  invoice_id: string;
  line_type: LineType;
  raw_label: string;
  quantity: string;
  unit: string | null;
  unit_price_net: string;
  vat_rate_pct: string;
  line_total_gross_cents: string;
  is_storno: boolean;
}

function mapLineItem(row: LineItemRow): StoredLineItem {
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    lineType: row.line_type,
    rawLabel: row.raw_label,
    quantity: row.quantity,
    unit: row.unit,
    unitPriceNet: row.unit_price_net,
    vatRatePct: row.vat_rate_pct,
    lineTotalGrossCents: BigInt(row.line_total_gross_cents),
    isStorno: row.is_storno,
  };
}

function mapInvoice(row: InvoiceRow, lineItems: StoredLineItem[]): StoredInvoice {
  return {
    id: Number(row.id),
    gmailMessageId: row.gmail_message_id,
    fileSha256: row.file_sha256,
    sourceFormat: row.source_format,
    providerCui: row.provider_cui,
    providerName: row.provider_name,
    category: row.category,
    clientCode: row.client_code,
    consumptionPointId: row.consumption_point_id,
    invoiceSeries: row.invoice_series,
    invoiceNumber: row.invoice_number,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    billingPeriodStart: row.billing_period_start,
    billingPeriodEnd: row.billing_period_end,
    billingDays: row.billing_days,
    readingType: row.reading_type,
    oldIndex: row.old_index,
    newIndex: row.new_index,
    consumptionValue: row.consumption_value,
    consumptionUnit: row.consumption_unit,
    selfReadingWindowStart: row.self_reading_window_start,
    selfReadingWindowEnd: row.self_reading_window_end,
    totalAmountCents: BigInt(row.total_amount_cents),
    currency: row.currency,
    extractionConfidence: row.extraction_confidence,
    paymentStatus: row.payment_status,
    auditFlags: Array.isArray(row.audit_flags) ? row.audit_flags : [],
    rawExtractedJson: row.raw_extracted_json,
    lineItems,
    createdAt: new Date(row.created_at),
  };
}

export class PgInvoiceRepository implements InvoiceRepository {
  constructor(private readonly pool: Queryable) {}

  private async attachLines(rows: InvoiceRow[], db?: Queryable): Promise<StoredInvoice[]> {
    if (rows.length === 0) {
      return [];
    }
    const runner = db ?? this.pool;
    const ids = rows.map((r) => Number(r.id));
    const linesRes = await runner.query<LineItemRow>(
      'SELECT * FROM invoice_line_items WHERE invoice_id = ANY($1::bigint[]) ORDER BY id ASC',
      [ids],
    );
    const byInvoice = new Map<number, StoredLineItem[]>();
    for (const lineRow of linesRes.rows) {
      const mapped = mapLineItem(lineRow);
      const list = byInvoice.get(mapped.invoiceId) ?? [];
      list.push(mapped);
      byInvoice.set(mapped.invoiceId, list);
    }

    return rows.map((row) => mapInvoice(row, byInvoice.get(Number(row.id)) ?? []));
  }

  async findBySha256(fileSha256: string, db?: Queryable): Promise<StoredInvoice | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<InvoiceRow>(
      'SELECT * FROM parsed_invoices WHERE file_sha256 = $1 LIMIT 1',
      [fileSha256],
    );
    const list = await this.attachLines(res.rows, runner);
    return list[0] ?? null;
  }

  async findById(invoiceId: number, db?: Queryable): Promise<StoredInvoice | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<InvoiceRow>(
      'SELECT * FROM parsed_invoices WHERE id = $1 LIMIT 1',
      [invoiceId],
    );
    const list = await this.attachLines(res.rows, runner);
    return list[0] ?? null;
  }

  async findLatestForConsumptionPoint(
    providerCui: string,
    consumptionPointId: string,
    db?: Queryable,
  ): Promise<StoredInvoice | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<InvoiceRow>(
      `
      SELECT * FROM parsed_invoices
      WHERE provider_cui = $1 AND consumption_point_id = $2
      ORDER BY issue_date DESC, created_at DESC, id DESC
      LIMIT 1
      `,
      [providerCui, consumptionPointId],
    );
    const list = await this.attachLines(res.rows, runner);
    return list[0] ?? null;
  }

  async findRecentRealInvoices(
    providerCui: string,
    consumptionPointId: string,
    limit = 3,
    db?: Queryable,
  ): Promise<StoredInvoice[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<InvoiceRow>(
      `
      SELECT * FROM parsed_invoices
      WHERE provider_cui = $1
        AND consumption_point_id = $2
        AND reading_type IN ('SELF_READ', 'OPERATOR_READ')
        AND consumption_value IS NOT NULL
        AND consumption_value > 0
      ORDER BY issue_date DESC, created_at DESC, id DESC
      LIMIT $3
      `,
      [providerCui, consumptionPointId, limit],
    );
    return this.attachLines(res.rows, runner);
  }

  async findRecentEstimatedInvoicesSinceLastReal(
    providerCui: string,
    consumptionPointId: string,
    limit = 3,
    db?: Queryable,
  ): Promise<StoredInvoice[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<InvoiceRow>(
      `
      WITH last_real AS (
        SELECT issue_date, created_at, id
        FROM parsed_invoices
        WHERE provider_cui = $1
          AND consumption_point_id = $2
          AND reading_type IN ('SELF_READ', 'OPERATOR_READ', 'REGULARIZATION')
        ORDER BY issue_date DESC, created_at DESC, id DESC
        LIMIT 1
      )
      SELECT p.*
      FROM parsed_invoices p
      LEFT JOIN last_real lr ON TRUE
      WHERE p.provider_cui = $1
        AND p.consumption_point_id = $2
        AND p.reading_type = 'ESTIMATED'
        AND (
          lr.id IS NULL
          OR (p.issue_date, p.created_at, p.id) > (lr.issue_date, lr.created_at, lr.id)
        )
      ORDER BY p.issue_date DESC, p.created_at DESC, p.id DESC
      LIMIT $3
      `,
      [providerCui, consumptionPointId, limit],
    );
    return this.attachLines(res.rows, runner);
  }

  async findUnpaidOrHeld(db?: Queryable): Promise<StoredInvoice[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<InvoiceRow>(
      `
      SELECT * FROM parsed_invoices
      WHERE payment_status IN ('UNPAID', 'HOLD_BEFORE_PAYMENT')
      ORDER BY due_date ASC, id ASC
      `,
    );
    return this.attachLines(res.rows, runner);
  }

  async findAll(db?: Queryable): Promise<StoredInvoice[]> {
    const runner = db ?? this.pool;
    const res = await runner.query<InvoiceRow>(
      `
      SELECT * FROM parsed_invoices
      ORDER BY issue_date DESC, created_at DESC, id DESC
      `,
    );
    return this.attachLines(res.rows, runner);
  }

  async insertInvoiceWithLines(
    payload: InsertInvoicePayload,
    db?: Queryable,
  ): Promise<StoredInvoice> {
    const runner = db ?? this.pool;
    const { validated: v, effectiveReadingType, paymentStatus, auditFlags } = payload;

    const invRes = await runner.query<InvoiceRow>(
      `
      INSERT INTO parsed_invoices (
        gmail_message_id, file_sha256, source_format, provider_cui, provider_name,
        category, client_code, consumption_point_id, invoice_series, invoice_number,
        issue_date, due_date, billing_period_start, billing_period_end, billing_days,
        reading_type, old_index, new_index, consumption_value, consumption_unit,
        self_reading_window_start, self_reading_window_end, total_amount_cents,
        currency, extraction_confidence, payment_status, audit_flags, raw_extracted_json
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23,
        $24, $25, $26, $27::jsonb, $28::jsonb
      )
      RETURNING *
      `,
      [
        v.gmailMessageId,
        v.fileSha256,
        v.sourceFormat,
        v.providerCui,
        v.providerName,
        v.category,
        v.clientCode,
        v.consumptionPointId,
        v.invoiceSeries,
        v.invoiceNumber,
        v.issueDate,
        v.dueDate,
        v.billingPeriodStart,
        v.billingPeriodEnd,
        v.billingDays,
        effectiveReadingType,
        v.oldIndex,
        v.newIndex,
        v.consumptionValue,
        v.consumptionUnit,
        v.selfReadingWindowStart,
        v.selfReadingWindowEnd,
        v.totalAmountCents.toString(),
        v.currency,
        v.extractionConfidence,
        paymentStatus,
        JSON.stringify(auditFlags),
        JSON.stringify(v.rawExtractedJson),
      ],
    );

    const invRow = invRes.rows[0]!;
    const invoiceId = Number(invRow.id);
    const storedLines: StoredLineItem[] = [];

    for (const item of v.lineItems) {
      const lineRes = await runner.query<LineItemRow>(
        `
        INSERT INTO invoice_line_items (
          invoice_id, line_type, raw_label, quantity, unit,
          unit_price_net, vat_rate_pct, line_total_gross_cents, is_storno
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
          invoiceId,
          item.lineType,
          item.rawLabel,
          item.quantity,
          item.unit,
          item.unitPriceNet,
          item.vatRatePct,
          item.lineTotalGrossCents.toString(),
          item.isStorno,
        ],
      );
      storedLines.push(mapLineItem(lineRes.rows[0]!));
    }

    return mapInvoice(invRow, storedLines);
  }

  async updatePaymentStatus(
    invoiceId: number,
    status: PaymentStatus,
    db?: Queryable,
  ): Promise<StoredInvoice | null> {
    const runner = db ?? this.pool;
    const res = await runner.query<InvoiceRow>(
      'UPDATE parsed_invoices SET payment_status = $2 WHERE id = $1 RETURNING *',
      [invoiceId, status],
    );
    const list = await this.attachLines(res.rows, runner);
    return list[0] ?? null;
  }
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private nextInvoiceId = 1;
  private nextLineId = 1;
  private readonly invoices: StoredInvoice[] = [];

  private sortDesc(list: StoredInvoice[]): StoredInvoice[] {
    return [...list].sort((a, b) => {
      if (a.issueDate !== b.issueDate) {
        return a.issueDate < b.issueDate ? 1 : -1;
      }
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return b.createdAt.getTime() - a.createdAt.getTime();
      }
      return b.id - a.id;
    });
  }

  async findBySha256(fileSha256: string): Promise<StoredInvoice | null> {
    return this.invoices.find((i) => i.fileSha256 === fileSha256) ?? null;
  }

  async findById(invoiceId: number): Promise<StoredInvoice | null> {
    return this.invoices.find((i) => i.id === invoiceId) ?? null;
  }

  async findLatestForConsumptionPoint(
    providerCui: string,
    consumptionPointId: string,
  ): Promise<StoredInvoice | null> {
    const matching = this.sortDesc(
      this.invoices.filter(
        (i) => i.providerCui === providerCui && i.consumptionPointId === consumptionPointId,
      ),
    );
    return matching[0] ?? null;
  }

  async findRecentRealInvoices(
    providerCui: string,
    consumptionPointId: string,
    limit = 3,
  ): Promise<StoredInvoice[]> {
    return this.sortDesc(
      this.invoices.filter(
        (i) =>
          i.providerCui === providerCui &&
          i.consumptionPointId === consumptionPointId &&
          (i.readingType === 'SELF_READ' || i.readingType === 'OPERATOR_READ') &&
          i.consumptionValue !== null &&
          Number(i.consumptionValue) > 0,
      ),
    ).slice(0, limit);
  }

  async findRecentEstimatedInvoicesSinceLastReal(
    providerCui: string,
    consumptionPointId: string,
    limit = 3,
  ): Promise<StoredInvoice[]> {
    const sorted = this.sortDesc(
      this.invoices.filter(
        (i) => i.providerCui === providerCui && i.consumptionPointId === consumptionPointId,
      ),
    );
    const result: StoredInvoice[] = [];
    for (const inv of sorted) {
      if (
        inv.readingType === 'SELF_READ' ||
        inv.readingType === 'OPERATOR_READ' ||
        inv.readingType === 'REGULARIZATION'
      ) {
        break;
      }
      if (inv.readingType === 'ESTIMATED') {
        result.push(inv);
        if (result.length >= limit) {
          break;
        }
      }
    }
    return result;
  }

  async findUnpaidOrHeld(): Promise<StoredInvoice[]> {
    return this.invoices
      .filter((i) => i.paymentStatus === 'UNPAID' || i.paymentStatus === 'HOLD_BEFORE_PAYMENT')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  async findAll(): Promise<StoredInvoice[]> {
    return this.sortDesc(this.invoices);
  }

  async insertInvoiceWithLines(payload: InsertInvoicePayload): Promise<StoredInvoice> {
    const { validated: v, effectiveReadingType, paymentStatus, auditFlags } = payload;
    const id = this.nextInvoiceId++;
    const lineItems: StoredLineItem[] = v.lineItems.map((item) => ({
      ...item,
      id: this.nextLineId++,
      invoiceId: id,
    }));

    const stored: StoredInvoice = {
      id,
      gmailMessageId: v.gmailMessageId,
      fileSha256: v.fileSha256,
      sourceFormat: v.sourceFormat,
      providerCui: v.providerCui,
      providerName: v.providerName,
      category: v.category,
      clientCode: v.clientCode,
      consumptionPointId: v.consumptionPointId,
      invoiceSeries: v.invoiceSeries,
      invoiceNumber: v.invoiceNumber,
      issueDate: v.issueDate,
      dueDate: v.dueDate,
      billingPeriodStart: v.billingPeriodStart,
      billingPeriodEnd: v.billingPeriodEnd,
      billingDays: v.billingDays,
      readingType: effectiveReadingType,
      oldIndex: v.oldIndex,
      newIndex: v.newIndex,
      consumptionValue: v.consumptionValue,
      consumptionUnit: v.consumptionUnit,
      selfReadingWindowStart: v.selfReadingWindowStart,
      selfReadingWindowEnd: v.selfReadingWindowEnd,
      totalAmountCents: v.totalAmountCents,
      currency: v.currency,
      extractionConfidence: v.extractionConfidence,
      paymentStatus,
      auditFlags,
      rawExtractedJson: v.rawExtractedJson,
      lineItems,
      createdAt: new Date(),
    };
    this.invoices.push(stored);
    return stored;
  }

  async updatePaymentStatus(
    invoiceId: number,
    status: PaymentStatus,
  ): Promise<StoredInvoice | null> {
    const found = this.invoices.find((i) => i.id === invoiceId);
    if (!found) {
      return null;
    }
    found.paymentStatus = status;
    return found;
  }
}
