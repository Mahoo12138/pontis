import { Box, Group, Radio } from '@mantine/core';
import type { FolderTreeNode } from './folderTree';

/** One level of indentation. Deep bookmark trees are the reason this picker
 * exists, so the step has to stay small enough for six levels to fit the layer. */
const INDENT = 14;

/** The row's choice. A radio rather than a click-anywhere target: choosing a
 * folder is a single decision, and the same control reads the same in the
 * popup as in the settings tab. */
function FolderChoice({
  node,
  picked,
  onPick,
  groupName,
  trail,
}: {
  node: FolderTreeNode;
  picked: string;
  onPick: (id: string) => void;
  groupName: string;
  /** Where the folder lives, shown only when the row itself cannot say so —
   * i.e. in a search result, which is laid out flat. */
  trail?: string[];
}) {
  return (
    <Radio
      name={groupName}
      size="xs"
      checked={picked === node.id}
      onChange={() => onPick(node.id)}
      aria-label={node.title}
      label={
        <>
          {node.title}
          {node.bookmarks > 0 && !trail ? (
            <Box component="span" c="dimmed" fz="xs" ml={6}>
              {node.bookmarks} 个书签
            </Box>
          ) : null}
        </>
      }
      description={trail && trail.length ? trail.join(' / ') : undefined}
      styles={{
        label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }}
    />
  );
}

interface FolderTreePickerProps {
  nodes: FolderTreeNode[];
  picked: string;
  onPick: (id: string) => void;
  groupName: string;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  depth?: number;
}

/** Folders as a tree, one row each, with a row's subfolders hidden until that
 * row is opened. */
export function FolderTreePicker({
  nodes,
  picked,
  onPick,
  groupName,
  expanded,
  onToggle,
  depth = 0,
}: FolderTreePickerProps) {
  return (
    <>
      {nodes.map((node) => {
        const open = expanded.has(node.id);
        return (
          <Box key={node.id}>
            <Group gap={2} wrap="nowrap" pl={depth * INDENT} className="pontis-treeRow">
              {node.children.length > 0 ? (
                <button
                  type="button"
                  data-open={open || undefined}
                  aria-expanded={open}
                  aria-label={`${open ? '收起' : '展开'} ${node.title}`}
                  className="pontis-treeToggle"
                  onClick={() => onToggle(node.id)}
                >
                  <CaretGlyph />
                </button>
              ) : (
                // The spacer keeps a leaf's title on the same column as a
                // branch's, so the eye reads the levels by alignment alone.
                <Box w={18} flex="0 0 auto" />
              )}
              <FolderChoice node={node} picked={picked} onPick={onPick} groupName={groupName} />
            </Group>
            {open ? (
              <FolderTreePicker
                nodes={node.children}
                picked={picked}
                onPick={onPick}
                groupName={groupName}
                expanded={expanded}
                onToggle={onToggle}
                depth={depth + 1}
              />
            ) : null}
          </Box>
        );
      })}
    </>
  );
}

/** Search results laid out flat, each carrying the path that tells two
 * same-named folders apart. */
export function FolderHitList({
  hits,
  picked,
  onPick,
  groupName,
}: {
  hits: { node: FolderTreeNode; trail: string[] }[];
  picked: string;
  onPick: (id: string) => void;
  groupName: string;
}) {
  return (
    <>
      {hits.map(({ node, trail }) => (
        <Box key={node.id} className="pontis-treeRow">
          <FolderChoice
            node={node}
            picked={picked}
            onPick={onPick}
            groupName={groupName}
            trail={trail}
          />
        </Box>
      ))}
    </>
  );
}

/** Points right at rest and down when open. Drawn inline like the popup's
 * settings mark — the extension needs four glyphs in total, not an icon set. */
export function CaretGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden focusable="false">
      <path
        d="M4.5 2.5L8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
