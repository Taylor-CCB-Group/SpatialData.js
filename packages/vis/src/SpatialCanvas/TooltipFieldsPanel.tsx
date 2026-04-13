import type { CSSProperties } from 'react';

const helperTextStyle: CSSProperties = {
  color: '#888',
  fontSize: '11px',
  marginBottom: 8,
};

export interface TooltipFieldsPanelProps {
  tableName?: string;
  availableFields: string[];
  selectedFields?: string[];
  onChange: (nextFields: string[]) => void;
  noAssociatedTableMessage: string;
  helperText?: string;
  noFieldsMessage?: string;
}

export function TooltipFieldsPanel({
  tableName,
  availableFields,
  selectedFields = [],
  onChange,
  noAssociatedTableMessage,
  helperText,
  noFieldsMessage = 'No eligible obs columns found on the associated table',
}: TooltipFieldsPanelProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <div style={{ color: '#ccc', fontSize: '12px', marginBottom: 4 }}>
          Tooltip fields
        </div>
        {tableName ? (
          <>
            <div style={helperTextStyle}>Table: {tableName}</div>
            {helperText ? <div style={helperTextStyle}>{helperText}</div> : null}
            {availableFields.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {availableFields.map((field) => {
                  const checked = selectedFields.includes(field);
                  return (
                    <label
                      key={field}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        color: '#ccc',
                        fontSize: '12px',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const current = new Set(selectedFields);
                          if (checked) {
                            current.delete(field);
                          } else {
                            current.add(field);
                          }
                          onChange(Array.from(current));
                        }}
                      />
                      {field}
                    </label>
                  );
                })}
              </div>
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
