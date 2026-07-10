/**
 * ドメイン定数（ステータス文字列の一元管理・backlog 11-4）
 *
 * 欠員（vacancy）のライフサイクルで使うステータス文字列を1箇所に集約する。
 * 従来はこれらのリテラルがサーバー5ファイル＋HTML3画面に散在しており、
 * 「休講」のような4つ目の決着区分を足すたびに多数のファイルを同時修正する必要があった。
 * サーバー側の判定・分岐はすべてこの定数を参照する（値は従来と完全に同一＝挙動不変）。
 *
 * ※ GAS は全 .gs を単一グローバルに連結する。読み込み順に依存しないよう、
 *    他ファイルのトップレベル定数を「関数の外」で参照しないこと（関数内参照は安全）。
 *    このファイル自身の中での参照（VACANCY_RESULT_VALUES）は宣言順で安全。
 *
 * ※ HTML（manage/home/respond）は、サーバーが返した同じ文字列値を表示・比較している。
 *    値は不変のため画面側の変更は不要。将来テンプレート経由で画面へ渡す場合の唯一の出所もここ。
 */

// 欠員の決着結果（vacancies.result に記録する確定値）
const VACANCY_RESULT = {
  FILLED: '補充済',    // 代行者が確定した（先着自動確定 or 職員の手動確定）
  SOLO: '1人テイク',   // 相方が残るので1人で実施（補充できなかった）
  STAFF: '職員対応',   // 誰も残らず職員が対応する
};

// setVacancyResult 等で「妥当な決着値か」を検証するための一覧（宣言順で安全）
const VACANCY_RESULT_VALUES = [VACANCY_RESULT.FILLED, VACANCY_RESULT.SOLO, VACANCY_RESULT.STAFF];

// 時間割ビュー（home）でコマに付ける欠員状況。result 未確定/未発生のときの表示値。
// 決着済みのコマは result 値（VACANCY_RESULT）がそのまま status になる。
const COURSE_VACANCY_STATUS = {
  NORMAL: '通常',        // 欠員なし
  OPEN: '欠員対応中',    // 未解決の欠員がある
};

// 代行依頼への回答（responses.answer に記録する値）
const ANSWER = {
  ACCEPT: '承諾',
  DECLINE: '辞退',
};

// 決着済みの欠員をさらに決着させようとしたときのユーザー向けメッセージ（職員パス共通）。
// 先着確定と職員操作が競合したときに、黙って上書きせず画面更新を促す（backlog 10-1）。
const MSG_VACANCY_SETTLED =
  'この欠員は既に決着済みです（先着確定など）。画面を更新して最新の状態をご確認ください。';
