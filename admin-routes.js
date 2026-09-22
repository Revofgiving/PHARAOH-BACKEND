const rules = require('./rules-engine');
const multer = require('multer');

function registerAdminRoutes({ app, pg, security }) {
  const VALID_TESTIMONIANZA_STATO = ['IN_ATTESA', 'APPROVATA', 'RIFIUTATA', 'NASCOSTA'];

  const uploadRisorsa = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 15 * 1024 * 1024,
      files: 1
    },
    fileFilter: (_req, file, cb) => {
      const allowedMimeTypes = new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'application/pdf'
      ]);

      if (!allowedMimeTypes.has(file.mimetype)) {
        return cb(new Error('Formato file non consentito'));
      }

      cb(null, true);
    }
  });

  const uploadToPinata = async (file) => {
    const pinataJwt = String(process.env.PINATA_JWT || '').trim();
    const gatewayBase = String(
      process.env.PINATA_GATEWAY_URL || 'https://gateway.pinata.cloud'
    ).trim().replace(/\/$/, '');

    if (!pinataJwt) {
      const error = new Error('PINATA_JWT non configurato');
      error.statusCode = 503;
      throw error;
    }

    const blob = new Blob([file.buffer], { type: file.mimetype });
    const uploadFile = new File([blob], file.originalname, {
      type: file.mimetype
    });

    const formData = new FormData();
    formData.append('file', uploadFile);
    formData.append('pinataMetadata', JSON.stringify({
      name: file.originalname,
      keyvalues: {
        progetto: 'PHARAOH',
        origine: 'pannello-admin'
      }
    }));
    formData.append('pinataOptions', JSON.stringify({
      cidVersion: 1
    }));

    const response = await fetch(
      'https://api.pinata.cloud/pinning/pinFileToIPFS',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pinataJwt}`
        },
        body: formData
      }
    );

    const result = await response.json().catch(() => null);

    if (!response.ok || !result?.IpfsHash) {
      const error = new Error(
        result?.error?.details ||
        result?.error ||
        result?.message ||
        `Upload Pinata fallito con stato ${response.status}`
      );
      error.statusCode = 502;
      throw error;
    }

    return {
      cid: result.IpfsHash,
      fileUrl: `${gatewayBase}/ipfs/${result.IpfsHash}`,
      pinSize: Number(result.PinSize || file.size || 0),
      timestamp: result.Timestamp || new Date().toISOString()
    };
  };

  const levelLabel = (livello) => {
    if (livello === null || livello === undefined) return 'Entrata';
    const m = {
      0: 'Entrata',
      1: 'Step Anubis',
      2: 'Step Horus',
      3: 'Step Rha',
      4: 'Step Thot',
      5: 'Step Iside'
    };
    return m[Number(livello)] || `Step ${livello}`;
  };

  const walletMask = (wallet) => {
    if (!wallet || wallet.length < 12) return wallet || '';
    return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  };

  const toBool = (v, fallback = false) => {
    if (v === true || v === 'true' || v === '1' || v === 1) return true;
    if (v === false || v === 'false' || v === '0' || v === 0) return false;
    return fallback;
  };

  const parsePaging = (query) => {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    return { page, pageSize, offset: (page - 1) * pageSize };
  };

  // ===================================================================
  // AUTH ADMIN
  // ===================================================================
  app.get('/api/admin/auth/verify', security.requireAdminKey, (_req, res) => {
    res.json({ success: true, authorized: true });
  });

  // ===================================================================
  // AUDIT API PRIVILEGIATE
  // ===================================================================
  app.get('/api/admin/audit', security.requireAdminKey, async (req, res) => {
    try {
      const limit = security.validateIntegerInRange(req.query.limit ?? 100, 1, 500, 'limit');
      const params = [];
      const clauses = [];
      if (req.query.method) {
        const method = String(req.query.method).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          return res.status(400).json({ success: false, error: 'Metodo audit non valido' });
        }
        params.push(method);
        clauses.push(`method = $${params.length}`);
      }
      if (req.query.status) {
        params.push(security.validateIntegerInRange(req.query.status, 100, 599, 'status'));
        clauses.push(`status_code = $${params.length}`);
      }
      if (req.query.path) {
        const pathFilter = security.sanitizeString(req.query.path, 200);
        params.push(`%${pathFilter}%`);
        clauses.push(`path LIKE $${params.length}`);
      }
      params.push(limit);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await pg.queryMany(
        `SELECT id, request_id, method, path, status_code, admin_authenticated,
                duration_ms, created_at
         FROM api_audit_log
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params
      );
      res.json({ success: true, rows, count: rows.length });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // DASHBOARD
  // ===================================================================
  app.get('/api/admin/dashboard', security.requireAdminKey, async (_req, res) => {
    try {
      const [
        totPartecipanti,
        nuovi7gg,
        posizioniAttive,
        tavoleAperte,
        doniCompletati,
        doniInAttesa,
        usdcDistribuiti,
        testimonianzePub,
        risorsePub
      ] = await Promise.all([
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM accounts WHERE tipo IN ('PRIMARIO','PERPETUO','GEMELLO')`),
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM accounts WHERE created_at >= NOW() - INTERVAL '7 days'`),
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM posizioni WHERE status = 'ATTIVO'`),
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM tavole WHERE status = 'APERTA'`),
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM donazioni WHERE status = 'COMPLETATA'`),
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM doni_pendenti WHERE status IN ('PENDING','PROCESSING','ACCEPTED')`),
        pg.queryOne(`SELECT COALESCE(SUM(importo), 0)::numeric AS s FROM donazioni WHERE status = 'COMPLETATA'`),
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM testimonianze WHERE stato = 'APPROVATA'`),
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM risorse WHERE stato = 'PUBBLICATA'`)
      ]);

      const crescitaPartecipanti = await pg.queryMany(`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket, COUNT(*)::int AS value
        FROM accounts
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 1 ASC
      `);

      const andamentoDoni = await pg.queryMany(`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket, COALESCE(SUM(importo),0)::numeric AS value
        FROM donazioni
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1
        ORDER BY 1 ASC
      `);

      const posizioniPerLivello = await pg.queryMany(`
        SELECT t.livello, COUNT(*)::int AS value
        FROM posizioni p
        JOIN tavole t ON p.tavola_id = t.id
        GROUP BY t.livello
        ORDER BY t.livello ASC
      `);

      const statoTavole = await pg.queryMany(`
        SELECT status, COUNT(*)::int AS value
        FROM tavole
        GROUP BY status
        ORDER BY status
      `);

      const ultimeAttivita = await pg.queryMany(`
        SELECT *
        FROM (
          SELECT created_at, 'DONO'::text AS tipo, donor_wallet AS wallet, importo::text AS dettaglio FROM donazioni
          UNION ALL
          SELECT created_at, 'REGISTRAZIONE'::text AS tipo, wallet, COALESCE(nome, '') AS dettaglio FROM accounts
          UNION ALL
          SELECT created_at, 'TESTIMONIANZA'::text AS tipo, wallet, stato AS dettaglio FROM testimonianze
        ) x
        ORDER BY created_at DESC
        LIMIT 20
      `);

      res.json({
        success: true,
        cards: {
          partecipantiTotali: Number(totPartecipanti?.c || 0),
          nuoviPartecipanti7gg: Number(nuovi7gg?.c || 0),
          posizioniAttive: Number(posizioniAttive?.c || 0),
          tavoleAperte: Number(tavoleAperte?.c || 0),
          doniCompletati: Number(doniCompletati?.c || 0),
          doniInAttesa: Number(doniInAttesa?.c || 0),
          usdcDistribuiti: Number(usdcDistribuiti?.s || 0),
          testimonianzePubblicate: Number(testimonianzePub?.c || 0),
          risorseCaricate: Number(risorsePub?.c || 0)
        },
        charts: {
          crescitaPartecipanti,
          andamentoDoni,
          posizioniPerLivello: posizioniPerLivello.map((x) => ({ ...x, label: levelLabel(x.livello) })),
          statoTavole
        },
        ultimeAttivita: ultimeAttivita.map((a) => ({
          ...a,
          walletMasked: walletMask(a.wallet)
        }))
      });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // PARTECIPANTI
  // ===================================================================
  app.get('/api/admin/partecipanti', security.requireAdminKey, async (req, res) => {
    try {
      const { q, status, livello, kyc, dateFrom, dateTo } = req.query;
      const minPos = Number(req.query.minPosizioni || 0);
      const maxPos = Number(req.query.maxPosizioni || 100000);
      const minDoni = Number(req.query.minDoni || 0);
      const maxDoni = Number(req.query.maxDoni || 1000000000);
      const { page, pageSize, offset } = parsePaging(req.query);

      const filters = [];
      const params = [];
      const push = (value, sql) => {
        params.push(value);
        filters.push(sql.replace('?', `$${params.length}`));
      };

      if (q) push(`%${String(q).toLowerCase()}%`, `LOWER(a.wallet) LIKE ?`);
      if (status) push(String(status), `a.status = ?`);
      if (dateFrom) push(String(dateFrom), `a.created_at >= ?::timestamptz`);
      if (dateTo) push(String(dateTo), `a.created_at <= ?::timestamptz`);
      if (kyc) {
        if (String(kyc) === 'PRESENTE') filters.push(`kv.wallet IS NOT NULL`);
        if (String(kyc) === 'ASSENTE') filters.push(`kv.wallet IS NULL`);
      }
      if (livello !== undefined && livello !== '') push(Number(livello), `COALESCE(ls.max_level, 0) = ?`);

      push(minPos, `COALESCE(pc.posizioni_count,0) >= ?`);
      push(maxPos, `COALESCE(pc.posizioni_count,0) <= ?`);
      push(minDoni, `COALESCE(dr.doni_ricevuti,0) >= ?`);
      push(maxDoni, `COALESCE(dr.doni_ricevuti,0) <= ?`);

      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

      const baseSql = `
        FROM accounts a
        LEFT JOIN (
          SELECT wallet, COUNT(*)::int AS posizioni_count
          FROM posizioni
          GROUP BY wallet
        ) pc ON pc.wallet = a.wallet
        LEFT JOIN (
          SELECT destinatario_wallet AS wallet, COALESCE(SUM(importo),0)::numeric AS doni_ricevuti
          FROM donazioni
          WHERE destinatario_wallet IS NOT NULL
          GROUP BY destinatario_wallet
        ) dr ON dr.wallet = a.wallet
        LEFT JOIN (
          SELECT wallet, MAX(t.livello)::int AS max_level
          FROM posizioni p
          JOIN tavole t ON t.id = p.tavola_id
          GROUP BY wallet
        ) ls ON ls.wallet = a.wallet
        LEFT JOIN (
          SELECT wallet, status
          FROM kyc_verifications
        ) kv ON kv.wallet = a.wallet
        LEFT JOIN (
          SELECT wallet, MAX(stato) AS testimonianza_status
          FROM testimonianze
          GROUP BY wallet
        ) ts ON ts.wallet = a.wallet
        ${where}
      `;

      const totalRow = await pg.queryOne(`SELECT COUNT(*)::int AS total ${baseSql}`, params);

      const rows = await pg.queryMany(`
        SELECT
          a.wallet,
          a.created_at AS data_registrazione,
          a.status AS stato_account,
          COALESCE(pc.posizioni_count,0) AS numero_posizioni,
          (
            SELECT COUNT(DISTINCT tavola_id)::int
            FROM posizioni p2 WHERE p2.wallet = a.wallet
          ) AS tavole_partecipate,
          COALESCE(dr.doni_ricevuti,0)::numeric AS doni_ricevuti,
          (
            SELECT MAX(created_at) FROM donazioni d WHERE d.donor_wallet = a.wallet
          ) AS ultimo_accesso,
          kv.status AS kyc_stato,
          COALESCE(ts.testimonianza_status, 'NESSUNA') AS testimonianza_stato,
          COALESCE(ls.max_level, 0) AS livello
        ${baseSql}
        ORDER BY a.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, pageSize, offset]);

      res.json({
        success: true,
        page,
        pageSize,
        total: Number(totalRow?.total || 0),
        rows
      });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.get('/api/admin/partecipanti/:wallet', security.requireAdminKey, async (req, res) => {
    try {
      const wallet = security.validateWallet(req.params.wallet, 'wallet');
      const account = await pg.queryOne(`SELECT * FROM accounts WHERE wallet = $1`, [wallet]);
      if (!account) return res.status(404).json({ success: false, error: 'Partecipante non trovato' });

      const [posizioni, storico, testimonianze, kyc, note, tavoleAttive, doni, doniPendenti] = await Promise.all([
        pg.queryMany(`
          SELECT p.*, t.numero AS tavola_numero, t.livello, t.status AS tavola_status
          FROM posizioni p
          JOIN tavole t ON t.id = p.tavola_id
          WHERE p.wallet = $1
          ORDER BY p.created_at DESC
        `, [wallet]),
        pg.queryMany(`SELECT * FROM storico_avanzamenti WHERE wallet = $1 ORDER BY created_at DESC LIMIT 100`, [wallet]),
        pg.queryMany(`SELECT * FROM testimonianze WHERE wallet = $1 ORDER BY created_at DESC`, [wallet]),
        pg.queryOne(
          `SELECT wallet, status, verified_at, created_at
           FROM kyc_verifications WHERE wallet = $1`,
          [wallet]
        ),
        pg.queryMany(`SELECT * FROM admin_notes WHERE wallet = $1 ORDER BY created_at DESC`, [wallet]),
        pg.queryMany(`
          SELECT DISTINCT t.*
          FROM tavole t
          JOIN posizioni p ON p.tavola_id = t.id
          WHERE p.wallet = $1 AND t.status = 'APERTA'
          ORDER BY t.numero ASC
        `, [wallet]),
        pg.queryMany(`SELECT * FROM donazioni WHERE destinatario_wallet = $1 OR donor_wallet = $1 ORDER BY created_at DESC`, [wallet]),
        pg.queryMany(`SELECT * FROM doni_pendenti WHERE wallet = $1 ORDER BY created_at DESC`, [wallet])
      ]);

      const maxLevel = posizioni.reduce((m, p) => Math.max(m, Number(p.livello || 0)), 0);

      res.json({
        success: true,
        partecipante: account,
        walletMasked: walletMask(wallet),
        stepCorrente: levelLabel(maxLevel),
        kyc,
        posizioni,
        tavoleAttive,
        doni,
        doniPendenti,
        storico,
        testimonianze,
        note
      });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/partecipanti/:wallet/note', security.requireAdminKey, async (req, res) => {
    try {
      const wallet = security.validateWallet(req.params.wallet, 'wallet');
      const nota = security.sanitizeString(req.body.nota, 2000);
      const createdBy = security.sanitizeString(req.body.createdBy, 120) || 'admin';
      if (!nota) return res.status(400).json({ success: false, error: 'Nota obbligatoria' });

      const row = await pg.queryOne(
        `INSERT INTO admin_notes (wallet, nota, created_by) VALUES ($1, $2, $3) RETURNING *`,
        [wallet, nota, createdBy]
      );
      res.json({ success: true, note: row });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // POSIZIONI E TAVOLE
  // ===================================================================
  app.get('/api/admin/posizioni-tavole', security.requireAdminKey, async (req, res) => {
    try {
      const { step, stato, mode } = req.query;
      const params = [];
      const clauses = [];
      if (step !== undefined && step !== '') {
        params.push(Number(step));
        clauses.push(`t.livello = $${params.length}`);
      }
      if (stato) {
        params.push(String(stato));
        clauses.push(`t.status = $${params.length}`);
      }
      if (mode === 'complete') clauses.push(`COALESCE(pc.occupate,0) >= t.capacita`);
      if (mode === 'attesa') clauses.push(`COALESCE(pc.occupate,0) < t.capacita`);
      if (mode === 'new') clauses.push(`t.created_at >= NOW() - INTERVAL '7 days'`);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      const rows = await pg.queryMany(`
        SELECT
          t.*,
          COALESCE(pc.occupate,0)::int AS posti_occupati,
          (t.capacita - COALESCE(pc.occupate,0))::int AS posti_disponibili,
          COALESCE(dg.doni_generati,0)::numeric AS doni_generati
        FROM tavole t
        LEFT JOIN (
          SELECT tavola_id, COUNT(*)::int AS occupate
          FROM posizioni
          GROUP BY tavola_id
        ) pc ON pc.tavola_id = t.id
        LEFT JOIN (
          SELECT tavola_id, COALESCE(SUM(importo),0)::numeric AS doni_generati
          FROM donazioni
          GROUP BY tavola_id
        ) dg ON dg.tavola_id = t.id
        ${where}
        ORDER BY t.numero ASC
        LIMIT 300
      `, params);

      res.json({
        success: true,
        rows: rows.map((r) => ({
          ...r,
          step_label: levelLabel(r.livello)
        }))
      });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.get('/api/admin/posizioni-tavole/:numero', security.requireAdminKey, async (req, res) => {
    try {
      const numero = security.validatePositiveInt(req.params.numero, 'numero');
      const sezione = String(req.query.sezione || 'PHARAOH').toUpperCase();
      if (!['ENTRATA', 'PHARAOH'].includes(sezione)) {
        return res.status(400).json({ success: false, error: 'Sezione tavola non valida' });
      }
      const tavola = await pg.queryOne(
        `SELECT * FROM tavole WHERE numero = $1 AND sezione = $2`,
        [numero, sezione]
      );
      if (!tavola) return res.status(404).json({ success: false, error: 'Tavola non trovata' });
      const posizioni = await pg.queryMany(`
        SELECT
          p.*,
          COALESCE(a.ticket_number, NULL) AS ticket_number
        FROM posizioni p
        LEFT JOIN accounts a ON a.wallet = p.wallet
        WHERE p.tavola_id = $1
        ORDER BY p.casella ASC
      `, [tavola.id]);
      res.json({
        success: true,
        tavola: {
          ...tavola,
          step_label: levelLabel(tavola.livello),
          posti_occupati: posizioni.length,
          posti_disponibili: Math.max(0, Number(tavola.capacita || 0) - posizioni.length)
        },
        posizioni
      });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // DONI
  // ===================================================================
  app.get('/api/admin/doni', security.requireAdminKey, async (req, res) => {
    try {
      const { wallet, stato, tipo, step, dateFrom, dateTo } = req.query;
      const minImporto = Number(req.query.minImporto || 0);
      const maxImporto = Number(req.query.maxImporto || 1000000000);
      const params = [minImporto, maxImporto];
      const clauses = [`x.importo_num BETWEEN $1 AND $2`];

      if (wallet) {
        params.push(`%${String(wallet).toLowerCase()}%`);
        clauses.push(`LOWER(x.wallet_ricevente) LIKE $${params.length}`);
      }
      if (stato) {
        params.push(String(stato));
        clauses.push(`x.stato = $${params.length}`);
      }
      if (tipo) {
        params.push(String(tipo));
        clauses.push(`x.tipo_dono = $${params.length}`);
      }
      if (step !== undefined && step !== '') {
        params.push(Number(step));
        clauses.push(`COALESCE(x.livello, 0) = $${params.length}`);
      }
      if (dateFrom) {
        params.push(String(dateFrom));
        clauses.push(`x.created_at >= $${params.length}::timestamptz`);
      }
      if (dateTo) {
        params.push(String(dateTo));
        clauses.push(`x.created_at <= $${params.length}::timestamptz`);
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await pg.queryMany(`
        SELECT *
        FROM (
          SELECT
            ('D-' || d.id::text) AS id,
            d.created_at,
            COALESCE(d.destinatario_wallet, d.donor_wallet) AS wallet_ricevente,
            d.importo::numeric AS importo_num,
            d.importo::text AS importo,
            'USDC'::text AS token,
            d.tipo::text AS tipo_dono,
            COALESCE(d.tipo, 'DONO') AS provenienza,
            COALESCE(d.status, 'COMPLETATA') AS stato,
            d.tx_hash AS tx,
            NULL::text AS note,
            d.livello,
            d.turno
          FROM donazioni d
        ) x
        ${where}
        ORDER BY x.created_at DESC
        LIMIT 500
      `, params);

      res.json({ success: true, rows });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.get('/api/admin/doni/:id', security.requireAdminKey, async (req, res) => {
    try {
      const rawId = String(req.params.id);
      if (rawId.startsWith('D-')) {
        const id = Number(rawId.slice(2));
        const row = await pg.queryOne(`SELECT * FROM donazioni WHERE id = $1`, [id]);
        if (!row) return res.status(404).json({ success: false, error: 'Dono non trovato' });
        return res.json({ success: true, tipo: 'DONAZIONE', dono: row });
      }
      return res.status(400).json({ success: false, error: 'Formato ID dono non valido' });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // TESTIMONIANZE
  // ===================================================================
  app.post('/api/testimonianze', async (req, res) => {
    try {
      const wallet = security.validateWallet(req.body.wallet, 'wallet');
      const testo = security.sanitizeString(req.body.testo, 6000);
      const immagineUrl = security.sanitizeString(req.body.immagineUrl, 1000);
      if (!testo) return res.status(400).json({ success: false, error: 'Testo testimonianza obbligatorio' });

      const [posRow, donoRow, levelRow] = await Promise.all([
        pg.queryOne(`SELECT COUNT(*)::int AS c FROM posizioni WHERE wallet = $1`, [wallet]),
        pg.queryOne(`SELECT COALESCE(SUM(importo),0)::numeric AS s FROM donazioni WHERE destinatario_wallet = $1`, [wallet]),
        pg.queryOne(`
          SELECT MAX(t.livello)::int AS max_level
          FROM posizioni p
          JOIN tavole t ON t.id = p.tavola_id
          WHERE p.wallet = $1
        `, [wallet])
      ]);

      const posizioniCount = Number(posRow?.c || 0);
      const donoRicevuto = Number(donoRow?.s || 0);
      if (posizioniCount <= 0 && donoRicevuto <= 0) {
        return res.status(403).json({
          success: false,
          error: 'Puoi inviare testimonianze solo se hai almeno una posizione valida o un dono ricevuto.'
        });
      }

      const livello = levelRow?.max_level ?? null;
      const row = await pg.queryOne(`
        INSERT INTO testimonianze (wallet, posizioni_count, livello, livello_label, dono_ricevuto, testo, immagine_url, stato, mostra_pubblicamente, in_evidenza)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'IN_ATTESA',false,false)
        RETURNING *
      `, [wallet, posizioniCount, livello, levelLabel(livello), donoRicevuto, testo, immagineUrl || null]);

      res.json({ success: true, testimonianza: row });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.get('/api/admin/testimonianze', security.requireAdminKey, async (req, res) => {
    try {
      const { stato, q } = req.query;
      const params = [];
      const clauses = [];
      if (stato) {
        params.push(String(stato));
        clauses.push(`t.stato = $${params.length}`);
      }
      if (q) {
        params.push(`%${String(q).toLowerCase()}%`);
        clauses.push(`(LOWER(t.wallet) LIKE $${params.length} OR LOWER(t.testo) LIKE $${params.length})`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await pg.queryMany(`
        SELECT t.*
        FROM testimonianze t
        ${where}
        ORDER BY t.created_at DESC
        LIMIT 400
      `, params);
      res.json({ success: true, rows });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/testimonianze/:id/update', security.requireAdminKey, async (req, res) => {
    try {
      const id = security.validatePositiveInt(req.params.id, 'id');
      const stato = security.sanitizeString(req.body.stato, 30);
      const testo = security.sanitizeString(req.body.testo, 6000);
      const mostra = req.body.mostra_pubblicamente;
      const evidenza = req.body.in_evidenza;
      const noteAdmin = security.sanitizeString(req.body.note_admin, 2000);

      if (stato && !VALID_TESTIMONIANZA_STATO.includes(stato)) {
        return res.status(400).json({ success: false, error: 'Stato testimonianza non valido' });
      }

      const existing = await pg.queryOne(`SELECT * FROM testimonianze WHERE id = $1`, [id]);
      if (!existing) return res.status(404).json({ success: false, error: 'Testimonianza non trovata' });

      const nextStato = stato || existing.stato;
      const nextMostra = mostra === undefined ? existing.mostra_pubblicamente : toBool(mostra, existing.mostra_pubblicamente);
      const row = await pg.queryOne(`
        UPDATE testimonianze
        SET
          stato = $1,
          testo = COALESCE($2, testo),
          mostra_pubblicamente = $3,
          in_evidenza = $4,
          note_admin = COALESCE($5, note_admin),
          updated_at = NOW()
        WHERE id = $6
        RETURNING *
      `, [
        nextStato,
        testo || null,
        nextMostra,
        evidenza === undefined ? existing.in_evidenza : toBool(evidenza, existing.in_evidenza),
        noteAdmin || null,
        id
      ]);

      res.json({ success: true, testimonianza: row });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/testimonianze/:id/delete-image', security.requireAdminKey, async (req, res) => {
    try {
      const id = security.validatePositiveInt(req.params.id, 'id');
      const row = await pg.queryOne(`
        UPDATE testimonianze SET immagine_url = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);
      if (!row) return res.status(404).json({ success: false, error: 'Testimonianza non trovata' });
      res.json({ success: true, testimonianza: row });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.get('/api/testimonianze/pubbliche', async (_req, res) => {
    try {
      const rows = await pg.queryMany(`
        SELECT id, wallet, posizioni_count, livello_label, testo, immagine_url, created_at, in_evidenza
        FROM testimonianze
        WHERE stato = 'APPROVATA' AND mostra_pubblicamente = true
        ORDER BY in_evidenza DESC, created_at DESC
        LIMIT 50
      `);
      res.json({
        success: true,
        rows: rows.map((r) => ({
          ...r,
          autore: walletMask(r.wallet),
          subtitle: `${walletMask(r.wallet)} · ${r.posizioni_count} posizioni · ${r.livello_label || 'Step'}`
        }))
      });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // COMUNICAZIONI
  // ===================================================================
  app.get('/api/admin/comunicazioni', security.requireAdminKey, async (req, res) => {
    try {
      const stato = req.query.stato ? String(req.query.stato) : null;
      const rows = stato
        ? await pg.queryMany(`SELECT * FROM comunicazioni WHERE stato = $1 ORDER BY fissata DESC, created_at DESC`, [stato])
        : await pg.queryMany(`SELECT * FROM comunicazioni ORDER BY fissata DESC, created_at DESC`);
      res.json({ success: true, rows });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/comunicazioni/upsert', security.requireAdminKey, async (req, res) => {
    try {
      const id = req.body.id ? Number(req.body.id) : null;
      const titolo = security.sanitizeString(req.body.titolo, 240);
      const contenuto = security.sanitizeString(req.body.contenuto, 12000);
      if (!titolo || !contenuto) {
        return res.status(400).json({ success: false, error: 'Titolo e contenuto obbligatori' });
      }

      const payload = {
        titolo,
        contenuto,
        immagine_url: security.sanitizeString(req.body.immagine_url, 1000),
        categoria: security.sanitizeString(req.body.categoria, 120) || 'AGGIORNAMENTO',
        stato: security.sanitizeString(req.body.stato, 20) || 'BOZZA',
        fissata: toBool(req.body.fissata, false),
        scheduled_for: req.body.scheduled_for ? new Date(req.body.scheduled_for).toISOString() : null,
        published_at: req.body.published_at ? new Date(req.body.published_at).toISOString() : null,
        created_by: security.sanitizeString(req.body.created_by, 120) || 'admin'
      };

      const row = id
        ? await pg.queryOne(`
          UPDATE comunicazioni
          SET titolo = $1, contenuto = $2, immagine_url = $3, categoria = $4, stato = $5, fissata = $6,
              scheduled_for = $7, published_at = $8, created_by = $9, updated_at = NOW()
          WHERE id = $10
          RETURNING *
        `, [payload.titolo, payload.contenuto, payload.immagine_url, payload.categoria, payload.stato, payload.fissata, payload.scheduled_for, payload.published_at, payload.created_by, id])
        : await pg.queryOne(`
          INSERT INTO comunicazioni (titolo, contenuto, immagine_url, categoria, stato, fissata, scheduled_for, published_at, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING *
        `, [payload.titolo, payload.contenuto, payload.immagine_url, payload.categoria, payload.stato, payload.fissata, payload.scheduled_for, payload.published_at, payload.created_by]);

      res.json({ success: true, comunicazione: row });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/comunicazioni/:id/delete', security.requireAdminKey, async (req, res) => {
    try {
      const id = security.validatePositiveInt(req.params.id, 'id');
      await pg.query(`DELETE FROM comunicazioni WHERE id = $1`, [id]);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.get('/api/comunicazioni/pubbliche', async (_req, res) => {
    try {
      const nowIso = new Date().toISOString();
      const rows = await pg.queryMany(`
        SELECT *
        FROM comunicazioni
        WHERE stato = 'PUBBLICATA'
          AND (scheduled_for IS NULL OR scheduled_for <= $1::timestamptz)
        ORDER BY fissata DESC, COALESCE(published_at, created_at) DESC
        LIMIT 100
      `, [nowIso]);
      res.json({ success: true, rows });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // RISORSE
  // ===================================================================
  app.post(
    '/api/admin/risorse/upload',
    security.requireAdminKey,
    uploadRisorsa.single('file'),
    async (req, res) => {
      try {
        if (!req.file) {
          return res.status(400).json({
            success: false,
            error: 'File obbligatorio'
          });
        }

        const uploaded = await uploadToPinata(req.file);
        const isImage = req.file.mimetype.startsWith('image/');

        res.status(201).json({
          success: true,
          upload: {
            cid: uploaded.cid,
            file_url: uploaded.fileUrl,
            anteprima_url: isImage ? uploaded.fileUrl : '',
            file_name: req.file.originalname,
            file_size: `${Math.ceil(req.file.size / 1024)} KB`,
            mime_type: req.file.mimetype,
            pin_size: uploaded.pinSize,
            uploaded_at: uploaded.timestamp
          }
        });
      } catch (e) {
        const status = Number(e.statusCode) || 500;
        res.status(status).json({
          success: false,
          error: security.sanitizeError(e)
        });
      }
    }
  );

  app.get('/api/admin/risorse', security.requireAdminKey, async (req, res) => {
    try {
      const categoria = req.query.categoria ? String(req.query.categoria) : null;
      const stato = req.query.stato ? String(req.query.stato) : null;
      const visibilita = req.query.visibilita ? String(req.query.visibilita) : null;
      const params = [];
      const clauses = [];
      if (categoria) { params.push(categoria); clauses.push(`categoria = $${params.length}`); }
      if (stato) { params.push(stato); clauses.push(`stato = $${params.length}`); }
      if (visibilita) { params.push(visibilita); clauses.push(`visibilita = $${params.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = await pg.queryMany(`SELECT * FROM risorse ${where} ORDER BY created_at DESC LIMIT 300`, params);
      res.json({ success: true, rows });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/risorse/upsert', security.requireAdminKey, async (req, res) => {
    try {
      const id = req.body.id ? Number(req.body.id) : null;
      const titolo = security.sanitizeString(req.body.titolo, 240);
      if (!titolo) return res.status(400).json({ success: false, error: 'Titolo risorsa obbligatorio' });

      const data = {
        titolo,
        descrizione: security.sanitizeString(req.body.descrizione, 4000),
        categoria: security.sanitizeString(req.body.categoria, 120) || 'Guide',
        tipo: security.sanitizeString(req.body.tipo, 30) || 'LINK',
        file_url: security.sanitizeString(req.body.file_url, 1000),
        file_name: security.sanitizeString(req.body.file_name, 240),
        file_size: security.sanitizeString(req.body.file_size, 120),
        mime_type: security.sanitizeString(req.body.mime_type, 120),
        link_url: security.sanitizeString(req.body.link_url, 1000),
        anteprima_url: security.sanitizeString(req.body.anteprima_url, 1000),
        visibilita: security.sanitizeString(req.body.visibilita, 20) || 'COMMUNITY',
        stato: security.sanitizeString(req.body.stato, 20) || 'BOZZA',
        autore_wallet: security.sanitizeString(req.body.autore_wallet, 120) || null
      };

      const row = id
        ? await pg.queryOne(`
          UPDATE risorse
          SET titolo = $1, descrizione = $2, categoria = $3, tipo = $4, file_url = $5, file_name = $6, file_size = $7,
              mime_type = $8, link_url = $9, anteprima_url = $10, visibilita = $11, stato = $12, autore_wallet = $13, updated_at = NOW()
          WHERE id = $14
          RETURNING *
        `, [data.titolo, data.descrizione, data.categoria, data.tipo, data.file_url, data.file_name, data.file_size, data.mime_type, data.link_url, data.anteprima_url, data.visibilita, data.stato, data.autore_wallet, id])
        : await pg.queryOne(`
          INSERT INTO risorse (titolo, descrizione, categoria, tipo, file_url, file_name, file_size, mime_type, link_url, anteprima_url, visibilita, stato, autore_wallet)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          RETURNING *
        `, [data.titolo, data.descrizione, data.categoria, data.tipo, data.file_url, data.file_name, data.file_size, data.mime_type, data.link_url, data.anteprima_url, data.visibilita, data.stato, data.autore_wallet]);

      res.json({ success: true, risorsa: row });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/risorse/:id/delete', security.requireAdminKey, async (req, res) => {
    try {
      const id = security.validatePositiveInt(req.params.id, 'id');
      await pg.query(`DELETE FROM risorse WHERE id = $1`, [id]);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.get('/api/risorse/pubbliche', async (_req, res) => {
    try {
      const rows = await pg.queryMany(`
        SELECT *
        FROM risorse
        WHERE stato = 'PUBBLICATA' AND visibilita IN ('PUBBLICA', 'COMMUNITY')
        ORDER BY created_at DESC
        LIMIT 200
      `);
      res.json({ success: true, rows });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // EVENTI
  // ===================================================================
  app.get('/api/admin/eventi', security.requireAdminKey, async (req, res) => {
    try {
      const tab = req.query.tab ? String(req.query.tab) : 'all';
      const params = [];
      let where = '';
      if (tab === 'future') {
        where = `WHERE data_evento >= CURRENT_DATE`;
      } else if (tab === 'past') {
        where = `WHERE data_evento < CURRENT_DATE`;
      }
      if (req.query.stato) {
        params.push(String(req.query.stato));
        where = where ? `${where} AND stato = $1` : `WHERE stato = $1`;
      }
      const rows = await pg.queryMany(`SELECT * FROM eventi ${where} ORDER BY data_evento DESC, created_at DESC LIMIT 300`, params);
      res.json({ success: true, rows });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/eventi/upsert', security.requireAdminKey, async (req, res) => {
    try {
      const id = req.body.id ? Number(req.body.id) : null;
      const titolo = security.sanitizeString(req.body.titolo, 240);
      const descrizione = security.sanitizeString(req.body.descrizione, 4000);
      const data_evento = security.sanitizeString(req.body.data_evento, 30);
      if (!titolo || !data_evento) {
        return res.status(400).json({ success: false, error: 'Titolo e data evento obbligatori' });
      }
      const payload = {
        titolo,
        descrizione,
        data_evento,
        orario_evento: security.sanitizeString(req.body.orario_evento, 20),
        piattaforma_link: security.sanitizeString(req.body.piattaforma_link, 1000),
        immagine_url: security.sanitizeString(req.body.immagine_url, 1000),
        stato: security.sanitizeString(req.body.stato, 30) || 'PROGRAMMATO',
        visibilita: security.sanitizeString(req.body.visibilita, 20) || 'COMMUNITY',
        registrazione_link: security.sanitizeString(req.body.registrazione_link, 1000),
        created_by: security.sanitizeString(req.body.created_by, 120) || 'admin'
      };
      const row = id
        ? await pg.queryOne(`
          UPDATE eventi
          SET titolo = $1, descrizione = $2, data_evento = $3, orario_evento = $4, piattaforma_link = $5, immagine_url = $6,
              stato = $7, visibilita = $8, registrazione_link = $9, created_by = $10, updated_at = NOW()
          WHERE id = $11
          RETURNING *
        `, [payload.titolo, payload.descrizione, payload.data_evento, payload.orario_evento, payload.piattaforma_link, payload.immagine_url, payload.stato, payload.visibilita, payload.registrazione_link, payload.created_by, id])
        : await pg.queryOne(`
          INSERT INTO eventi (titolo, descrizione, data_evento, orario_evento, piattaforma_link, immagine_url, stato, visibilita, registrazione_link, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING *
        `, [payload.titolo, payload.descrizione, payload.data_evento, payload.orario_evento, payload.piattaforma_link, payload.immagine_url, payload.stato, payload.visibilita, payload.registrazione_link, payload.created_by]);
      res.json({ success: true, evento: row });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/eventi/:id/delete', security.requireAdminKey, async (req, res) => {
    try {
      const id = security.validatePositiveInt(req.params.id, 'id');
      await pg.query(`DELETE FROM eventi WHERE id = $1`, [id]);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.get('/api/eventi/pubblici', async (_req, res) => {
    try {
      const rows = await pg.queryMany(`
        SELECT *
        FROM eventi
        WHERE visibilita IN ('PUBBLICA','COMMUNITY')
        ORDER BY data_evento ASC, orario_evento ASC
        LIMIT 200
      `);
      const today = new Date().toISOString().slice(0, 10);
      const futuri = rows.filter((r) => r.data_evento >= today);
      const passati = rows.filter((r) => r.data_evento < today);
      res.json({ success: true, futuri, passati });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // IMPOSTAZIONI ADMIN
  // ===================================================================
  app.get('/api/admin/impostazioni', security.requireAdminKey, async (_req, res) => {
    try {
      const rows = await pg.queryMany(`SELECT key, value, updated_at FROM admin_settings ORDER BY key ASC`);
      const asObj = {};
      const safeRows = rows.map(row => ({ ...row, value: security.redactSecrets(row.value) }));
      for (const r of safeRows) asObj[r.key] = r.value;
      res.json({ success: true, settings: asObj, rows: safeRows });
    } catch (e) {
      res.status(500).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  app.post('/api/admin/impostazioni', security.requireAdminKey, async (req, res) => {
    try {
      const key = security.sanitizeString(req.body.key, 120);
      const value = req.body.value;
      if (!key) return res.status(400).json({ success: false, error: 'Chiave impostazione obbligatoria' });
      security.assertNoSecretSetting(key, value);
      await pg.query(`
        INSERT INTO admin_settings (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [key, JSON.stringify(value ?? {})]);
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ success: false, error: security.sanitizeError(e) });
    }
  });

  // ===================================================================
  // QUICK OPTIONS / META
  // ===================================================================
  app.get('/api/admin/meta/options', security.requireAdminKey, (_req, res) => {
    res.json({
      success: true,
      categorieComunicazioni: ['Avviso', 'Aggiornamento', 'Importante', 'Benvenuto', 'Tecnico', 'Evento'],
      categorieRisorse: ['Presentazioni', 'Guide', 'Regolamenti', 'Eventi', 'Locandine', 'Video', 'Comunicazioni', 'Materiale formativo', 'Documenti tecnici'],
      visibilita: ['PUBBLICA', 'COMMUNITY', 'ADMIN'],
      statiTestimonianza: VALID_TESTIMONIANZA_STATO,
      statiComunicazione: ['BOZZA', 'PUBBLICATA'],
      statiRisorsa: ['BOZZA', 'PUBBLICATA'],
      statiEvento: ['PROGRAMMATO', 'CONCLUSO', 'ANNULLATO'],
      livelli: Object.keys(rules.IMPORTI).length ? [
        { value: 0, label: levelLabel(0) },
        { value: 1, label: levelLabel(1) },
        { value: 2, label: levelLabel(2) },
        { value: 3, label: levelLabel(3) },
        { value: 4, label: levelLabel(4) },
        { value: 5, label: levelLabel(5) }
      ] : []
    });
  });
}

module.exports = {
  registerAdminRoutes
};
