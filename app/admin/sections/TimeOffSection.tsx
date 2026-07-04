import { formatBlockRange } from '../../../src/shared/index.js';
import { IconCalendar } from '../../shared-ui/icons';
import type { Settings } from '../shared.js';

export function TimeOffSection({
  blocked,
  blockStart,
  blockEnd,
  setBlockStart,
  setBlockEnd,
  addBlock,
  removeBlock,
}: {
  blocked: Settings['blocked'];
  blockStart: string;
  blockEnd: string;
  setBlockStart: (value: string) => void;
  setBlockEnd: (value: string) => void;
  addBlock: () => Promise<void>;
  removeBlock: (id: string) => Promise<void>;
}) {
  return (
    <>
      <h2>
        <IconCalendar size={18} /> Time off
      </h2>
      <p className="pb-applies">Changes here apply immediately.</p>
      <ul>
        {blocked.map((b) => (
          <li key={b.id}>
            {formatBlockRange(b.startDate, b.endDate)}
            <button onClick={() => void removeBlock(b.id)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="pb-inline">
        <input type="date" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
        <input type="date" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
        <button onClick={addBlock}>Block range</button>
      </div>
    </>
  );
}
