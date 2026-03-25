import type { CSSProperties, DragEvent } from 'react';
import type { LayerConfig } from './types';

const rowStyle = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  marginBottom: 4,
  borderRadius: 4,
  cursor: 'pointer',
  border: active ? '1px solid #4a9eff' : '1px solid #333',
  backgroundColor: active ? '#2a3f55' : '#2a2a2a',
  fontSize: '12px',
  color: '#ddd',
});

const gripStyle: React.CSSProperties = {
  cursor: 'grab',
  color: '#666',
  userSelect: 'none',
};

export interface LayerOrderListProps {
  layerOrder: string[];
  layers: Record<string, LayerConfig>;
  selectedLayerId: string | null;
  onSelect: (id: string) => void;
  reorderLayers: (order: string[]) => void;
}

export function LayerOrderList({
  layerOrder,
  layers,
  selectedLayerId,
  onSelect,
  reorderLayers,
}: LayerOrderListProps) {
  const onDragStart = (e: DragEvent<HTMLSpanElement>, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, targetId: string) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId || draggedId === targetId) return;
    const order = [...layerOrder];
    const from = order.indexOf(draggedId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, draggedId);
    reorderLayers(order);
  };

  if (layerOrder.length === 0) {
    return <div style={{ color: '#666', fontSize: '12px' }}>No layers enabled</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: '#888', fontSize: '11px', marginBottom: 8 }}>Drag to reorder (bottom → top)</div>
      {layerOrder.map((id) => {
        const layer = layers[id];
        if (!layer) return null;
        return (
          <div
            key={id}
            role="button"
            tabIndex={0}
            style={rowStyle(selectedLayerId === id)}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(id);
              }
            }}
            onDragOver={onDragOver}
            onDrop={(e) => onDrop(e, id)}
          >
            <span
              draggable
              onDragStart={(e) => onDragStart(e, id)}
              style={gripStyle}
              title="Drag to reorder"
            >
              ⣿
            </span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {layer.elementKey} ({layer.type})
            </span>
            <span style={{ color: layer.visible ? '#6a9' : '#666' }}>{layer.visible ? 'on' : 'off'}</span>
          </div>
        );
      })}
    </div>
  );
}
