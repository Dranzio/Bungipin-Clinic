const PDFDocument = require('pdfkit');
const pool = require('../config/db');

function reportFilters(query) {
  const conditions = [];
  const values = [];

  if (query.start_date) {
    conditions.push('p.payment_date >= ?');
    values.push(query.start_date);
  }
  if (query.end_date) {
    conditions.push('p.payment_date <= ?');
    values.push(query.end_date);
  }

  return {
    sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '',
    values,
  };
}

/**
 * Fetch payment-level transaction rows plus totals for the selected period.
 * Shared by both the JSON endpoint and the PDF endpoint.
 */
async function fetchTransactionReport(query) {
  const filters = reportFilters(query);
  const [rows] = await pool.query(
    `SELECT p.payment_id, p.payment_date, p.amount, p.method, p.status,
            a.appointment_id, a.appointment_date,
            s.service_id, s.label AS service_label,
            u.user_id AS patient_id,
            CONCAT(u.first_name, ' ', u.last_name) AS patient_name
     FROM payments p
     JOIN appointments a ON a.appointment_id = p.appointment_id
     JOIN services s ON s.service_id = a.service_id
     JOIN users u ON u.user_id = a.patient_id
     WHERE 1 = 1${filters.sql}
     ORDER BY p.payment_date DESC, p.payment_id DESC`,
    filters.values
  );

  const totals = rows.reduce(
    (summary, row) => {
      summary.transaction_count += 1;
      if (row.status === 'paid') summary.paid_total += Number(row.amount);
      if (row.status === 'refunded') summary.refunded_total += Number(row.amount);
      summary.net_total = summary.paid_total - summary.refunded_total;
      return summary;
    },
    { transaction_count: 0, paid_total: 0, refunded_total: 0, net_total: 0 }
  );

  return { totals, transactions: rows };
}

/** Fetch requested-service counts, excluding cancelled appointments. */
async function fetchMostRequestedServices(query) {
  const conditions = ["a.appointment_status <> 'cancelled'"];
  const values = [];

  if (query.start_date) {
    conditions.push('a.appointment_date >= ?');
    values.push(query.start_date);
  }
  if (query.end_date) {
    conditions.push('a.appointment_date <= ?');
    values.push(query.end_date);
  }

  const requestedLimit = Number.parseInt(query.limit, 10);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 10;

  const [rows] = await pool.query(
    `SELECT s.service_id, s.label, COUNT(*) AS request_count,
            COALESCE(SUM(CASE WHEN a.appointment_status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count
     FROM appointments a
     JOIN services s ON s.service_id = a.service_id
     WHERE ${conditions.join(' AND ')}
     GROUP BY s.service_id, s.label
     ORDER BY request_count DESC, s.label ASC
     LIMIT ?`,
    [...values, limit]
  );

  return rows;
}

async function getTransactionReport(req, res) {
  try {
    const { totals, transactions } = await fetchTransactionReport(req.query);
    res.json({ filters: req.query, totals, transactions });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

async function getMostRequestedServices(req, res) {
  try {
    const services = await fetchMostRequestedServices(req.query);
    res.json({ filters: req.query, services });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
}

function pdfHeader(doc, title, query) {
  const rangeText =
    query.start_date || query.end_date
      ? `Range: ${query.start_date || 'earliest'} to ${query.end_date || 'latest'}`
      : 'Range: all time';

  doc
    .fontSize(18)
    .text(title)
    .fontSize(10)
    .fillColor('#555')
    .text(`${rangeText}  |  Generated ${new Date().toLocaleDateString()}`)
    .fillColor('#000')
    .moveDown();
}

async function getTransactionReportPdf(req, res) {
  try {
    const { totals, transactions } = await fetchTransactionReport(req.query);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="transaction-report.pdf"');

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    pdfHeader(doc, 'Transaction Report', req.query);

    doc.fontSize(13).text('Summary', { underline: true }).moveDown(0.3);
    doc
      .fontSize(10)
      .text(`Transactions: ${totals.transaction_count}`)
      .text(`Paid total: PHP ${totals.paid_total.toFixed(2)}`)
      .text(`Refunded total: PHP ${totals.refunded_total.toFixed(2)}`)
      .text(`Net total: PHP ${totals.net_total.toFixed(2)}`)
      .moveDown();

    doc.fontSize(13).text('Transactions', { underline: true }).moveDown(0.3);
    doc.fontSize(9);
    if (transactions.length === 0) {
      doc.text('No transactions in this range.');
    } else {
      transactions.forEach((t) => {
        const date = new Date(t.payment_date).toISOString().slice(0, 10);
        doc.text(
          `${date}  ${t.patient_name}  -  ${t.service_label}  -  PHP ${t.amount} (${t.method}, ${t.status})`
        );
      });
    }

    doc.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
}

async function getMostRequestedServicesPdf(req, res) {
  try {
    const services = await fetchMostRequestedServices(req.query);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="most-requested-services.pdf"');

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    pdfHeader(doc, 'Most Requested Services', req.query);

    doc.fontSize(13).text('Services', { underline: true }).moveDown(0.3);
    doc.fontSize(10);
    if (services.length === 0) {
      doc.text('No bookings in this range.');
    } else {
      services.forEach((s, i) => {
        doc.text(
          `${i + 1}. ${s.label}  -  ${s.request_count} bookings  (${s.completed_count} completed)`
        );
      });
    }

    doc.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ message: 'Server error', error: err.message });
    }
  }
}

module.exports = {
  getTransactionReport,
  getMostRequestedServices,
  getTransactionReportPdf,
  getMostRequestedServicesPdf,
};
