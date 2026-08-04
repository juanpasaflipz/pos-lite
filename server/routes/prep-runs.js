import { Router } from 'express';
import { all, get, run, getTenantId } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getTenant } from '../tenants.js';
import { applyStockDeltas } from '../helpers/stockLedger.js';

const router = Router();

/**
 * Producción — the conversion event between the two inventory layers.
 *
 * A prep run says "we took 10 kg of arrachera out of the walk-in and put 42
 * portions of asada on the line". Inputs are optional because outputs are what
 * the kitchen actually knows; inputs are what buy yield % and true cost per
 * portion, so the UI encourages them without demanding them.
 *
 * Every route here runs inside the tenant middleware's transaction. Do NOT open
 * a nested BEGIN — the outer one is load-bearing for RLS + PgBouncer.
 */

/** Resolve the tenant's mode. Two-stage routes are inert for everyone else. */
async function resolveMode(req) {
  const tenant = await getTenant(req.tenant?.id || getTenantId());
  return tenant?.inventory_mode || 'ingredients';
}

function requireTwoStage() {
  return async (req, res, next) => {
    const mode = await resolveMode(req);
    if (mode !== 'two_stage') {
      return res.status(403).json({
        error: 'Prep runs require two-stage inventory',
        code: 'INVENTORY_MODE_REQUIRED',
      });
    }
    next();
  };
}

/**
 * Validate and normalize the request lines.
 * @returns {{ok: true, inputs: Array, outputs: Array} | {ok: false, error: string}}
 */
function parseLines(body) {
  const rawInputs = body?.inputs;
  const rawOutputs = body?.outputs;

  if (rawInputs !== undefined && rawInputs !== null && !Array.isArray(rawInputs)) {
    return { ok: false, error: 'inputs must be an array when provided' };
  }
  if (!Array.isArray(rawOutputs) || rawOutputs.length === 0) {
    return { ok: false, error: 'outputs is required — a prep run has to say what came out' };
  }

  const inputs = [];
  for (const line of rawInputs || []) {
    const itemId = Number(line?.inventory_item_id);
    const quantity = Number(line?.quantity);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return { ok: false, error: 'each input needs a valid inventory_item_id' };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, error: 'each input quantity must be greater than 0' };
    }
    inputs.push({ itemId, quantity });
  }

  const outputs = [];
  for (const line of rawOutputs) {
    const itemId = Number(line?.inventory_item_id);
    const portions = Number(line?.portions);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return { ok: false, error: 'each output needs a valid inventory_item_id' };
    }
    if (!Number.isFinite(portions) || portions <= 0) {
      return { ok: false, error: 'each output portions must be greater than 0' };
    }
    outputs.push({ itemId, portions });
  }

  return { ok: true, inputs, outputs };
}

// POST /api/prep-runs — log a production run.
// Any clocked-in employee may log one: the person who cooked it is the person
// who knows the count, and making this manager-only would push the number to
// whoever happens to hold the PIN. Corrections are the gated operation.
router.post('/', requireAuth(), requireTwoStage(), async (req, res) => {
  try {
    const parsed = parseLines(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { inputs, outputs } = parsed;

    const tenantId = getTenantId();
    const employeeId = req.employee?.id || null;

    // Load every referenced item once, and enforce the layer each side belongs
    // to. Raw in, components out — a run that claims to have produced a raw
    // ingredient or consumed a finished portion is a data-entry error, and
    // letting it through would quietly corrupt both the yield math and the
    // availability derivation that reads kind='component'.
    const ids = [...new Set([...inputs.map((i) => i.itemId), ...outputs.map((o) => o.itemId)])];
    const items = await all(
      'SELECT id, name, unit, kind, cost_price FROM inventory_items WHERE id = ANY($1::int[])',
      [ids]
    );
    const byId = new Map(items.map((it) => [Number(it.id), it]));

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      return res.status(400).json({ error: `inventory item(s) not found: ${missing.join(', ')}` });
    }
    for (const line of inputs) {
      if (byId.get(line.itemId).kind !== 'raw') {
        return res.status(400).json({
          error: `"${byId.get(line.itemId).name}" is a component — prep inputs must be raw stock`,
        });
      }
    }
    for (const line of outputs) {
      if (byId.get(line.itemId).kind !== 'component') {
        return res.status(400).json({
          error: `"${byId.get(line.itemId).name}" is raw stock — prep outputs must be components`,
        });
      }
    }

    const notes = typeof req.body?.notes === 'string' && req.body.notes.trim()
      ? req.body.notes.trim()
      : null;

    const runRow = await get(
      `INSERT INTO prep_runs (tenant_id, employee_id, notes)
       VALUES ($1, $2, $3) RETURNING id, prepped_at`,
      [tenantId, employeeId, notes]
    );
    const runId = Number(runRow.id);

    // cost_at_time freezes the raw price as of this run, so a later price
    // change never rewrites what yesterday's batch actually cost.
    for (const line of inputs) {
      const costAtTime = Number(byId.get(line.itemId).cost_price) || 0;
      line.costAtTime = costAtTime;
      await run(
        `INSERT INTO prep_run_inputs (tenant_id, prep_run_id, inventory_item_id, quantity, cost_at_time)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, runId, line.itemId, line.quantity, costAtTime]
      );
    }
    for (const line of outputs) {
      await run(
        `INSERT INTO prep_run_outputs (tenant_id, prep_run_id, inventory_item_id, portions)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, runId, line.itemId, line.portions]
      );
    }

    // One batched stock movement: raw down, components up.
    const moved = await applyStockDeltas(null, [
      ...inputs.map((line) => ({
        itemId: line.itemId,
        delta: -line.quantity,
        reason: 'prep_consume',
        refType: 'prep_run',
        refId: runId,
        employeeId,
      })),
      ...outputs.map((line) => ({
        itemId: line.itemId,
        delta: line.portions,
        reason: 'prep_produce',
        refType: 'prep_run',
        refId: runId,
        employeeId,
      })),
    ]);
    const quantityByItem = new Map(moved.map((m) => [m.itemId, m.quantity]));

    // Costing. Total input cost spread evenly across every portion the run
    // produced, then folded into each component's running cost the same
    // weighted-average way a purchase folds into a raw item's.
    //
    // Even allocation is a simplification: a run that yields a premium cut and
    // a trim byproduct will over-cost the trim. Fine for single-output runs,
    // which is nearly all of them; revisit if multi-output prep becomes common.
    const totalInputCost = inputs.reduce((sum, l) => sum + l.quantity * (l.costAtTime || 0), 0);
    const totalPortions = outputs.reduce((sum, l) => sum + l.portions, 0);
    const costPerPortion = totalInputCost > 0 && totalPortions > 0
      ? totalInputCost / totalPortions
      : null;

    if (costPerPortion != null) {
      for (const line of outputs) {
        const item = byId.get(line.itemId);
        const prevCost = item.cost_price == null ? null : Number(item.cost_price);
        const after = quantityByItem.get(line.itemId) ?? line.portions;
        const before = after - line.portions;

        let newCost;
        if (before <= 0 || prevCost == null || prevCost === 0) {
          newCost = costPerPortion;
        } else {
          newCost = (before * prevCost + line.portions * costPerPortion) / (before + line.portions);
        }
        newCost = Math.round(newCost * 10000) / 10000;
        await run('UPDATE inventory_items SET cost_price = $1 WHERE id = $2', [newCost, line.itemId]);
        line.costPerPortion = newCost;
      }
    }

    res.status(201).json({
      id: runId,
      prepped_at: runRow.prepped_at,
      employee_id: employeeId,
      notes,
      inputs: inputs.map((l) => ({
        inventory_item_id: l.itemId,
        name: byId.get(l.itemId).name,
        unit: byId.get(l.itemId).unit,
        quantity: l.quantity,
        cost_at_time: l.costAtTime,
      })),
      outputs: outputs.map((l) => ({
        inventory_item_id: l.itemId,
        name: byId.get(l.itemId).name,
        portions: l.portions,
        new_quantity: quantityByItem.get(l.itemId) ?? null,
        cost_per_portion: l.costPerPortion ?? null,
      })),
      total_input_cost: Math.round(totalInputCost * 100) / 100,
      cost_per_portion: costPerPortion == null ? null : Math.round(costPerPortion * 10000) / 10000,
    });
  } catch (error) {
    console.error('[PrepRuns] create failed:', error.message);
    res.status(500).json({ error: 'Failed to log prep run' });
  }
});

// GET /api/prep-runs — recent runs, newest first.
// Always 200, even for ingredients-mode tenants: the `mode` field is how the
// POS client discovers which inventory model it is looking at (there is no
// other channel that carries tenant settings to an employee JWT).
router.get('/', requireAuth(), async (req, res) => {
  try {
    const mode = await resolveMode(req);
    if (mode !== 'two_stage') return res.json({ mode, runs: [] });

    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const runs = await all(
      `SELECT pr.id, pr.prepped_at, pr.notes, pr.employee_id, e.name AS employee_name
         FROM prep_runs pr
         LEFT JOIN employees e ON e.id = pr.employee_id
        ORDER BY pr.prepped_at DESC, pr.id DESC
        LIMIT $1`,
      [limit]
    );
    if (!runs.length) return res.json({ mode, runs: [] });

    const runIds = runs.map((r) => Number(r.id));
    const inputs = await all(
      `SELECT pri.prep_run_id, pri.inventory_item_id, pri.quantity, pri.cost_at_time,
              ii.name, ii.unit
         FROM prep_run_inputs pri
         JOIN inventory_items ii ON ii.id = pri.inventory_item_id
        WHERE pri.prep_run_id = ANY($1::int[])
        ORDER BY pri.id`,
      [runIds]
    );
    const outputs = await all(
      `SELECT pro.prep_run_id, pro.inventory_item_id, pro.portions, ii.name
         FROM prep_run_outputs pro
         JOIN inventory_items ii ON ii.id = pro.inventory_item_id
        WHERE pro.prep_run_id = ANY($1::int[])
        ORDER BY pro.id`,
      [runIds]
    );
    // Corrections are compensating ledger rows against the same run — the
    // original prep_run_* rows are never rewritten, so this is the only place
    // the adjusted truth lives.
    const corrections = await all(
      `SELECT pl.ref_id AS prep_run_id, pl.inventory_item_id, pl.delta, pl.created_at, ii.name
         FROM portion_ledger pl
         JOIN inventory_items ii ON ii.id = pl.inventory_item_id
        WHERE pl.ref_type = 'prep_run_correction' AND pl.ref_id = ANY($1::int[])
        ORDER BY pl.id`,
      [runIds]
    );

    const groupBy = (rows, mapFn) => {
      const out = new Map();
      for (const row of rows) {
        const key = Number(row.prep_run_id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(mapFn(row));
      }
      return out;
    };

    const inputsByRun = groupBy(inputs, (r) => ({
      inventory_item_id: Number(r.inventory_item_id),
      name: r.name,
      unit: r.unit,
      quantity: Number(r.quantity),
      cost_at_time: r.cost_at_time == null ? null : Number(r.cost_at_time),
    }));
    const outputsByRun = groupBy(outputs, (r) => ({
      inventory_item_id: Number(r.inventory_item_id),
      name: r.name,
      portions: Number(r.portions),
    }));
    const correctionsByRun = groupBy(corrections, (r) => ({
      inventory_item_id: Number(r.inventory_item_id),
      name: r.name,
      delta: Number(r.delta),
      created_at: r.created_at,
    }));

    res.json({
      mode,
      runs: runs.map((r) => {
        const runInputs = inputsByRun.get(Number(r.id)) || [];
        const runOutputs = outputsByRun.get(Number(r.id)) || [];
        const totalInputCost = runInputs.reduce(
          (sum, l) => sum + l.quantity * (l.cost_at_time || 0), 0
        );
        const totalPortions = runOutputs.reduce((sum, l) => sum + l.portions, 0);
        return {
          id: Number(r.id),
          prepped_at: r.prepped_at,
          employee_id: r.employee_id == null ? null : Number(r.employee_id),
          employee_name: r.employee_name || null,
          notes: r.notes,
          inputs: runInputs,
          outputs: runOutputs,
          corrections: correctionsByRun.get(Number(r.id)) || [],
          total_input_cost: Math.round(totalInputCost * 100) / 100,
          cost_per_portion: totalInputCost > 0 && totalPortions > 0
            ? Math.round((totalInputCost / totalPortions) * 10000) / 10000
            : null,
        };
      }),
    });
  } catch (error) {
    console.error('[PrepRuns] list failed:', error.message);
    res.status(500).json({ error: 'Failed to fetch prep runs' });
  }
});

// POST /api/prep-runs/:id/corrections — adjust a run after the fact.
//
// History is never mutated: the original prep_run_inputs/outputs rows stand and
// the correction is a compensating ledger entry, matching the audit discipline
// the 1.4.x work established. Gated on manage_inventory because "I miscounted"
// and "I want the number to say something else" look identical in the data.
router.post('/:id/corrections', requireAuth('manage_inventory'), requireTwoStage(), async (req, res) => {
  try {
    const runId = Number(req.params.id);
    if (!Number.isInteger(runId) || runId <= 0) {
      return res.status(400).json({ error: 'invalid prep run id' });
    }

    const existing = await get('SELECT id FROM prep_runs WHERE id = $1', [runId]);
    if (!existing) return res.status(404).json({ error: 'Prep run not found' });

    const entries = req.body?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries is required' });
    }

    const normalized = [];
    for (const entry of entries) {
      const itemId = Number(entry?.inventory_item_id);
      const delta = Number(entry?.delta);
      const side = entry?.side === 'input' ? 'input' : 'output';
      if (!Number.isInteger(itemId) || itemId <= 0) {
        return res.status(400).json({ error: 'each entry needs a valid inventory_item_id' });
      }
      if (!Number.isFinite(delta) || delta === 0) {
        return res.status(400).json({ error: 'each entry delta must be a non-zero number' });
      }
      normalized.push({
        itemId,
        delta,
        reason: side === 'input' ? 'prep_consume' : 'prep_produce',
        refType: 'prep_run_correction',
        refId: runId,
        employeeId: req.employee?.id || null,
      });
    }

    const moved = await applyStockDeltas(null, normalized);

    const note = typeof req.body?.notes === 'string' && req.body.notes.trim()
      ? req.body.notes.trim()
      : null;
    if (note) {
      await run(
        `UPDATE prep_runs
            SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $1
                             ELSE notes || E'\n' || $1 END
          WHERE id = $2`,
        [`[corrección] ${note}`, runId]
      );
    }

    res.json({
      prep_run_id: runId,
      corrections: normalized.map((n, i) => ({
        inventory_item_id: n.itemId,
        delta: n.delta,
        new_quantity: moved[i]?.quantity ?? null,
      })),
    });
  } catch (error) {
    console.error('[PrepRuns] correction failed:', error.message);
    res.status(500).json({ error: 'Failed to record correction' });
  }
});

export default router;
