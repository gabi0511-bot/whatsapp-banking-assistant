import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateAndNormalizeInvoice } from '../src/extraction/math.validator.js';
import { isUblInvoiceXml, parseUblInvoiceXml } from '../src/ingestion/xml.parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('xml.parser (Romanian e-Factura UBL 2.1)', () => {
  it('deterministically parses efactura_sample.xml with zero LLM calls and exact line-sum integrity', async () => {
    const xmlPath = path.join(__dirname, 'fixtures', 'efactura_sample.xml');
    const xml = await readFile(xmlPath, 'utf8');

    expect(isUblInvoiceXml(xml)).toBe(true);

    const parsed = parseUblInvoiceXml(xml);

    expect(parsed.provider_name).toBe('ENGIE ROMANIA S.A.');
    expect(parsed.provider_cui).toBe('RO13093222');
    expect(parsed.category).toBe('GAS');
    expect(parsed.invoice_series).toBe('ENG');
    expect(parsed.invoice_number).toBe('20260400987');
    expect(parsed.issue_date).toBe('2026-04-06');
    expect(parsed.due_date).toBe('2026-04-26');
    expect(parsed.billing_period_start).toBe('2026-03-01');
    expect(parsed.billing_period_end).toBe('2026-03-31');
    expect(parsed.client_code).toBe('55012345');
    expect(parsed.consumption_point_id).toBe('RO003G445566');
    expect(parsed.total_amount).toBe(133.88);
    expect(parsed.currency).toBe('RON');

    expect(parsed.meter_reading.reading_type).toBe('SELF_READ');
    expect(parsed.meter_reading.old_index).toBe(2100);
    expect(parsed.meter_reading.new_index).toBe(2135);
    expect(parsed.meter_reading.consumption_value).toBe(350);
    expect(parsed.meter_reading.consumption_unit).toBe('kWh');
    expect(parsed.meter_reading.self_reading_window_start).toBe(20);
    expect(parsed.meter_reading.self_reading_window_end).toBe(25);

    expect(parsed.line_items).toHaveLength(3);
    expect(parsed.line_items[0]?.line_type).toBe('GAS_ENERGY');
    expect(parsed.line_items[0]?.unit_price_net).toBe(0.26);
    expect(parsed.line_items[0]?.line_total_gross).toBe(108.29);

    expect(parsed.line_items[1]?.line_type).toBe('DISTRIBUTION_TAX');
    expect(parsed.line_items[1]?.line_total_gross).toBe(37.49);

    expect(parsed.line_items[2]?.line_type).toBe('DISCOUNT');
    expect(parsed.line_items[2]?.line_total_gross).toBe(-11.9);

    const validated = validateAndNormalizeInvoice({
      extracted: parsed,
      fileSha256: 'e'.repeat(64),
      sourceFormat: 'XML',
    });

    expect(validated.extractionConfidence).toBe('HIGH');
    expect(validated.totalAmountCents).toBe(13388n);
    expect(validated.validationFlags).toHaveLength(0);
  });

  it('rejects non-UBL XML documents cleanly', () => {
    expect(isUblInvoiceXml('<html><body>Not UBL</body></html>')).toBe(false);
    expect(() => parseUblInvoiceXml('<Order><ID>1</ID></Order>')).toThrow();
  });
});
