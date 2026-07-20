// Price + facts summary lines for the admin Services & rates cards. Pure and
// zero-dependency; presentation-only, like formatBlockRange. Fact fragments are
// picked by FIXED priority (window+weekdays, capacity, option count, night
// limits, question count) and capped at two, so summaries are deterministic.
// Spec: docs/superpowers/specs/2026-07-19-services-rates-redesign.md.

/** Just the option fields the summary needs — ServiceOptionForm (admin) is assignable. */
export type ServiceSummaryOption = {
  rate: number;
  startTime: string | null; // 'HH:MM'; null = no fixed window
  endTime: string | null;
  capacity: number | null;
  weekdaysOnly: boolean;
};

/** Structural subset of the admin ServiceForm — pass the whole form object. */
export type ServiceSummaryInput = {
  rateUnit: string;
  options: readonly ServiceSummaryOption[];
  questions: readonly unknown[]; // only the count is used
  minNights: number | null;
  maxNights: number | null;
  /** Labels of an explicit accepted-pets list; null/undefined = accepts all (no fact shown). */
  acceptedPetLabels?: string[] | null;
};

export type ServiceSummary = { price: string; facts: string };

/** '14:00' → '2', '08:30' → '8:30' — 12-hour hour, minutes only when non-zero,
 * no am/pm (the card's window fact reads "Weekdays 10–2" / "Daily 9–5").
 * Times are tenant-local wall-clock strings already; no timezone math. */
function compactTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour12}:${String(m).padStart(2, '0')}` : String(hour12);
}

function nightsWord(n: number): string {
  return n === 1 ? 'night' : 'nights';
}

export function serviceSummary(s: ServiceSummaryInput): ServiceSummary {
  const n = s.options.length;
  const rates = s.options.map((o) => o.rate);
  // "· N options" belongs in the price line only when every option costs the same.
  const countInPrice = n > 1 && rates.every((r) => r === rates[0]);

  let price: string;
  if (n === 0) price = 'No pricing yet';
  else if (n === 1) price = `$${rates[0]}/${s.rateUnit}`;
  else if (countInPrice) price = `$${rates[0]}/${s.rateUnit} · ${n} options`;
  else price = `from $${Math.min(...rates)}/${s.rateUnit}`;

  const facts: string[] = [];
  const windowed = s.options.find((o) => o.startTime !== null && o.endTime !== null);
  if (windowed && windowed.startTime !== null && windowed.endTime !== null) {
    const days = windowed.weekdaysOnly ? 'Weekdays' : 'Daily';
    facts.push(`${days} ${compactTime(windowed.startTime)}–${compactTime(windowed.endTime)}`);
  }
  const capped = s.options.find((o) => o.capacity !== null);
  if (capped) facts.push(`up to ${capped.capacity}`);
  if (n > 1 && !countInPrice) {
    facts.push(`${n} ${s.rateUnit === 'visit' ? 'visit lengths' : 'options'}`);
  }
  if (s.minNights !== null && s.maxNights !== null) {
    facts.push(`${s.minNights}–${s.maxNights} nights`);
  } else if (s.minNights !== null) {
    facts.push(`Min ${s.minNights} ${nightsWord(s.minNights)}`);
  } else if (s.maxNights !== null) {
    facts.push(`Max ${s.maxNights} ${nightsWord(s.maxNights)}`);
  }
  const q = s.questions.length;
  if (q > 0) facts.push(`${q} ${q === 1 ? 'question' : 'questions'}`);
  if (s.acceptedPetLabels && s.acceptedPetLabels.length > 0) {
    facts.push(
      s.acceptedPetLabels.length === 1
        ? `${s.acceptedPetLabels[0]} only`
        : s.acceptedPetLabels.join(' & '),
    );
  }

  return { price, facts: facts.slice(0, 2).join(' · ') };
}
