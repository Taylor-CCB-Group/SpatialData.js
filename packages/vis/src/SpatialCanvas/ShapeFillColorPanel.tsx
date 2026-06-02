import { useId, type CSSProperties } from 'react';
import type { ShapesLayerConfig } from './types';

const helperTextStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
  marginBottom: 8,
};

const selectStyle: CSSProperties = {
  backgroundColor: '#333',
  color: '#fff',
  border: '1px solid #444',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: '13px',
};

export interface ShapeFillColorPanelProps {
  tableName?: string;
  availableFields: string[];
  selected?: ShapesLayerConfig['fillColorByColumn'];
  onChange: (next: ShapesLayerConfig['fillColorByColumn'] | undefined) => void;
  noAssociatedTableMessage: string;
  noFieldsMessage?: string;
}

export function ShapeFillColorPanel({
  tableName,
  availableFields,
  selected,
  onChange,
  noAssociatedTableMessage,
  noFieldsMessage = 'No eligible obs columns found on the associated table',
}: ShapeFillColorPanelProps) {
  const fillColorSelectId = useId();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <label
          htmlFor={fillColorSelectId}
          style={{ color: '#ccc', fontSize: '12px', marginBottom: 4, display: 'block' }}
        >
          Fill colour
        </label>
        {tableName ? (
          <>
            <div style={helperTextStyle}>Table: {tableName}</div>
            {availableFields.length > 0 ? (
              <select
                id={fillColorSelectId}
                style={{ ...selectStyle, width: '100%' }}
                value={selected?.columnName ?? ''}
                onChange={(event) => {
                  const columnName = event.target.value;
                  onChange(columnName ? { columnName, mode: 'auto' } : undefined);
                }}
              >
                <option value="">None</option>
                {availableFields.map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ color: '#666', fontSize: '12px' }}>{noFieldsMessage}</div>
            )}
          </>
        ) : (
          <div style={{ color: '#666', fontSize: '12px' }}>{noAssociatedTableMessage}</div>
        )}
      </div>
    </div>
  );
}
