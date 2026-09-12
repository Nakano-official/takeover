/**
 * GAS コードを Node 上で動かすためのテストハーネス
 *
 * `src/*.gs` を**書き換えずにそのまま**読み込み、GAS 固有のもの（SpreadsheetApp・
 * Utilities・Logger・PropertiesService・UrlFetchApp）と Sheets.gs のデータアクセス層だけを
 * 差し替えて実行する。スプレッドシートはメモリ上の配列で代用する。
 *
 * ■ なぜこれがあるか
 *   GAS のテスト関数（`testVacancy` / `e2eVacancyFlow` 等）を1回動かすには
 *   clasp push → GASエディタを開く → 関数を選ぶ → 実行 → ログを読む、が毎回必要で、
 *   しかも実スプレッドシートを書き換えるので後片付けが要る。ロジックの確認のたびに
 *   これをやるのは重すぎて、結果として「変更したが確かめていない」が増える。
 *   ここで回せるものはここで回し、GAS 側には**GAS でしか確かめられないもの**
 *   （実 LockService の競合・実 Chat 送信・実カレンダー）だけを残す。
 *
 * ■ ここで確かめられないこと（GAS 側の e2e が必要）
 *   - LockService の実際の排他制御（ここでは単一スレッドなので CAS の分岐しか見ていない）
 *   - Sheets.gs の実行内キャッシュと withLock_ の相互作用
 *   - 実 Chat 送信・実カレンダー・実 CSV の文字コード
 *   - HTML 画面の挙動
 *
 * ■ 使い方
 *     const { Harness } = require('./gas-harness');
 *     const h = new Harness();
 *     h.load(['Constants.gs', 'Vacancy.gs']);
 *     h.add('staffs', { staff_id: 'S1', name: '…', role: '学生' });
 *     h.setUser({ staff_id: 'S1', name: '…', role: '学生' });
 *     h.G.submitAbsence('C001', h.time.today());
 *     h.check(cond, '説明');
 *     process.exitCode = h.report();
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_DIR = path.join(__dirname, '..', 'src');

// 本番のシート構成（Setup.js のヘッダーと一致させること）。
// 列が増えたらここも足す。ハーネスは「ヘッダーに無い列は書かない」という
// writeRowUpdates_ の挙動を再現するので、ここが古いと本番と違う結果になる。
const DEFAULT_HEADERS = {
  staffs: ['staff_id', 'name', 'role', 'skills', 'available_slots', 'personal_code'],
  courses: ['course_id', 'quarter', 'day', 'period', 'support_type', 'user_student',
    'subject', 'instructor', 'room', 'staff_a_id', 'staff_b_id', 'note', 'date'],
  vacancies: ['vacancy_id', 'date', 'course_id', 'absent_staff_id', 'notify_status',
    'result', 'substitute_staff_id', 'close_notified_at'],
  responses: ['vacancy_id', 'staff_id', 'answer', 'answered_at'],
  periods: ['period', 'start_time', 'end_time'],
  terms: ['term_id', 'system', 'start_date', 'end_date'],
  contacts: ['staff_id', 'name', 'email', 'phone', 'webhook_url'],
};

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// テスト側で使う時刻ヘルパー。スクリプトのタイムゾーンは Asia/Tokyo 前提だが、
// ハーネスは「実行環境のローカル時刻」で一貫させる（相対時刻しか使わないので判定は同じ）。
const time = {
  today: function () { return ymd(new Date()); },
  dateIn: function (days) { return ymd(new Date(Date.now() + days * 86400000)); },
  // 「今から n 分後」の HH:mm。授業開始時刻を動かして締切判定を試すのに使う
  hhmmIn: function (minutes) {
    const d = new Date(Date.now() + minutes * 60000);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  },
  dayJp: function (offsetDays) {
    const d = new Date(Date.now() + (offsetDays || 0) * 86400000);
    return ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  },
};

function copy(o) { return JSON.parse(JSON.stringify(o)); }

class Harness {
  constructor(options) {
    const opts = options || {};
    this.headers = copy(opts.headers || DEFAULT_HEADERS);
    this.db = {};
    this.notifyLog = [];      // 送信の代わりに記録される通知（種別・宛先の確認用）
    this.user = null;         // getCurrentUser_ が返す人
    this.time = time;
    this._pass = 0;
    this._fail = 0;
    this._failures = [];
    this.reset();
    this.context = vm.createContext(this._buildStubs());
    this.G = this.context;    // 読み込んだ GAS の関数はここに生える
  }

  // ── データ操作 ──────────────────────────────────────────
  reset() {
    this.db = {};
    Object.keys(this.headers).forEach((k) => { this.db[k] = []; });
    this.notifyLog.length = 0;
  }

  blank(sheet) {
    const o = {};
    this.headers[sheet].forEach((h) => { o[h] = ''; });
    return o;
  }

  /** 1行追加する。指定しなかった列は空文字で埋まる（本番の appendRow と同じ） */
  add(sheet, row) {
    const o = this.blank(sheet);
    Object.keys(row).forEach((k) => { o[k] = row[k]; });
    this.db[sheet].push(o);
    return o;
  }

  /** keyColumn=keyValue の行をそのまま返す（テスト側で中身を直接見る用） */
  row(sheet, keyColumn, keyValue) {
    return this.db[sheet].filter(
      (x) => String(x[keyColumn]).trim() === String(keyValue).trim())[0];
  }

  setUser(user) { this.user = user; }

  /** 記録された通知を種別で絞る */
  notifiesOf(kind) { return this.notifyLog.filter((n) => n.kind === kind); }

  // ── GAS コードの読み込み ────────────────────────────────
  /** src/ のファイルをこの順に読み込む（GAS の連結と同じで、順序が意味を持つ） */
  load(files) {
    files.forEach((f) => {
      const code = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
      vm.runInContext(code, this.context, { filename: f });
    });
    return this;
  }

  /**
   * 読み込んだコードの中で式を評価して結果を返す。
   *
   * `.gs` のトップレベル `const`（WORK_DAYS・VACANCE_RESULT 等）は、GAS では
   * グローバルだが Node の vm では**コンテキストのプロパティにならない**（レキシカル束縛）。
   * つまり `h.G.WORK_DAYS` は undefined になる。同じコンテキスト内の関数からは見えるので
   * 関数呼び出しには影響しないが、定数そのものをテストから読むときはこれを使う。
   *
   *     h.value('WORK_DAYS')            // → ['月','火',…]
   *     h.value('VACANCY_RESULT.SOLO')  // → '1人テイク'
   */
  value(expression) {
    return vm.runInContext('(' + expression + ')', this.context, { filename: 'harness:value' });
  }

  /** 追加のスタブを差し込む（読み込み前に呼ぶこと。関数宣言は後勝ちで上書きされる） */
  stub(obj) {
    Object.assign(this.context, obj);
    return this;
  }

  // ── 期待値チェック ──────────────────────────────────────
  section(title) { console.log('\n--- ' + title + ' ---'); }

  check(cond, message) {
    if (cond) { this._pass++; }
    else { this._fail++; this._failures.push(message); console.log('  ❌ ' + message); }
  }

  /** 結果を出力し、終了コード（0=成功 / 1=失敗）を返す */
  report() {
    console.log('\n=====================================');
    if (this._fail === 0) {
      console.log('✅ 全 ' + this._pass + ' 件成功');
      return 0;
    }
    console.log('❌ ' + this._fail + ' 件失敗（成功 ' + this._pass + ' 件）');
    this._failures.forEach((f) => { console.log('   - ' + f); });
    return 1;
  }

  // ── GAS ランタイムと Sheets.gs の差し替え ───────────────
  _buildStubs() {
    const self = this;
    const H = () => self.headers;
    const DB = () => self.db;

    return {
      console: console,
      Logger: { log: function () {} },

      Utilities: {
        formatDate: function (d, tz, fmt) {
          const Y = d.getFullYear(), M = pad(d.getMonth() + 1), D = pad(d.getDate());
          const h = pad(d.getHours()), m = pad(d.getMinutes()), s = pad(d.getSeconds());
          if (fmt === 'yyyy-MM-dd') return Y + '-' + M + '-' + D;
          if (fmt === 'yyyy-MM-dd HH:mm:ss') return Y + '-' + M + '-' + D + ' ' + h + ':' + m + ':' + s;
          if (fmt === 'HH:mm') return h + ':' + m;
          throw new Error('ハーネス未対応の日付書式: ' + fmt);
        },
        // Utilities.parseCsv 相当。引用符つきフィールドと "" エスケープ、CRLF を扱う。
        // Attendance.gs の CSV パーサを動かすために必要。
        parseCsv: function (text, delimiter) {
          const sep = delimiter || ',';
          const rows = [];
          var row = [], field = '', inQuotes = false, i = 0;
          const src = String(text);
          while (i < src.length) {
            const c = src[i];
            if (inQuotes) {
              if (c === '"') {
                if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
              }
              field += c; i++; continue;
            }
            if (c === '"') { inQuotes = true; i++; continue; }
            if (c === sep) { row.push(field); field = ''; i++; continue; }
            if (c === '\r') { i++; continue; }
            if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
            field += c; i++;
          }
          if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
          return rows;
        },
      },

      PropertiesService: {
        getScriptProperties: function () {
          return {
            getProperty: function () { return 'https://example.invalid/hook'; },
            setProperty: function () {},
            deleteProperty: function () {},
          };
        },
      },

      // 実送信は絶対にしない。呼ばれたら失敗させる（通知は下のスタブで捕まえる想定）
      UrlFetchApp: {
        fetch: function () { throw new Error('ハーネスから外部送信は行いません'); },
        fetchAll: function () { throw new Error('ハーネスから外部送信は行いません'); },
      },

      // ── Sheets.gs 相当 ──
      // 実行内キャッシュは持たない（毎回実データを見る）。CAS の判定結果は変わらない。
      SHEET: {
        STAFFS: 'staffs', COURSES: 'courses', VACANCIES: 'vacancies', RESPONSES: 'responses',
        PERIODS: 'periods', TERMS: 'terms', CONTACTS: 'contacts',
      },
      readRows: function (s) { return copy(DB()[s]); },
      getHeaders_: function (s) { return H()[s].slice(); },
      findRow: function (s, col, val) {
        const r = self.row(s, col, val);
        return r ? copy(r) : null;
      },
      filterRows: function (s, col, val) {
        return copy(DB()[s].filter((x) => String(x[col]).trim() === String(val).trim()));
      },
      updateRow: function (s, col, val, updates) {
        const r = self.row(s, col, val);
        if (!r) return false;
        // ヘッダーに無い列は書かない（本番の writeRowUpdates_ と同じ）
        Object.keys(updates).forEach((k) => { if (H()[s].indexOf(k) !== -1) r[k] = updates[k]; });
        return true;
      },
      updateRowIfGuard_: function (s, col, val, guard, mode, updates) {
        if (H()[s].indexOf(guard) === -1) throw new Error('ガード列が存在しません：' + guard);
        const r = self.row(s, col, val);
        if (!r) return { ok: false, applied: false, current: null };
        const before = copy(r);
        const filled = !!String(r[guard] || '').trim();
        const satisfies = (mode === 'empty') ? !filled : filled;
        if (!satisfies) return { ok: true, applied: false, current: before };
        Object.keys(updates).forEach((k) => { if (H()[s].indexOf(k) !== -1) r[k] = updates[k]; });
        return { ok: true, applied: true, current: before };
      },
      claimIfEmpty: function (s, col, val, guard, updates) {
        const res = self.context.updateRowIfGuard_(s, col, val, guard, 'empty', updates);
        return { ok: res.ok, claimed: res.applied, current: res.current };
      },
      appendRow: function (s, row) { self.add(s, row); return true; },
      appendRowWithId: function (s, idCol, prefix, row) {
        const max = DB()[s].reduce((m, r) => {
          const n = parseInt(String(r[idCol]).slice(prefix.length), 10);
          return isNaN(n) ? m : Math.max(m, n);
        }, 0);
        const id = prefix + String(max + 1).padStart(3, '0');
        const o = self.blank(s);
        o[idCol] = id;
        Object.keys(row).forEach((k) => { o[k] = row[k]; });
        DB()[s].push(o);
        return id;
      },
      upsertRow: function (s, matchObj, row) {
        const hit = DB()[s].filter((x) => Object.keys(matchObj).every(
          (k) => String(x[k]).trim() === String(matchObj[k]).trim()))[0];
        if (hit) {
          Object.keys(row).forEach((k) => { hit[k] = row[k]; });
          return 'updated';
        }
        const o = self.blank(s);
        Object.keys(matchObj).forEach((k) => { o[k] = matchObj[k]; });
        Object.keys(row).forEach((k) => { o[k] = row[k]; });
        DB()[s].push(o);
        return 'inserted';
      },
      deleteRowByKey: function (s, col, val) {
        const before = DB()[s].length;
        self.db[s] = DB()[s].filter((x) => String(x[col]).trim() !== String(val).trim());
        return before - self.db[s].length;
      },
      invalidateSheetCache_: function () {},
      withLock_: function (fn) { return fn(); },

      // ── code.js / Terms.gs 相当（画面・権限まわり）──
      getCurrentUser_: function () { return self.user; },
      requireStaff_: function () {
        if (!self.user || self.user.role !== '職員') throw new Error('職員限定の操作です。');
      },
      getAppUrl_: function () { return 'https://example.invalid/app'; },
      readTerms_: function () { return copy(DB().terms); },
      todayJst_: function () { return time.today(); },

      // ── Notify.gs 相当 ──
      // 実送信の代わりに notifyLog へ積む。宛先と種別が正しいかをテスト側で見る。
      notifyNewVacancy: function (id, reopened) {
        self.notifyLog.push({ kind: 'new', id: id, reopened: !!reopened });
        return { staff: true, candidates: [], errors: [] };
      },
      notifyVacancyFilled: function (id, sub) {
        self.notifyLog.push({ kind: 'filled', id: id, sub: sub });
        return { staff: true, substitute: true, others: [], errors: [] };
      },
      notifyVacancyClosed: function (id, label) {
        self.notifyLog.push({ kind: 'closed', id: id, label: label });
        return { others: [], errors: [] };
      },
      notifySubstituteReleased: function (id, sub) {
        self.notifyLog.push({ kind: 'released', id: id, sub: sub });
        return { sent: true, reason: '' };
      },
      notifyRecruitClosed: function (id, reason, suggestion) {
        self.notifyLog.push({ kind: 'recruitClosed', id: id, reason: reason, suggestion: suggestion });
        return { staff: true, others: [], errors: [] };
      },
    };
  }
}

module.exports = { Harness, DEFAULT_HEADERS, time, SRC_DIR };
