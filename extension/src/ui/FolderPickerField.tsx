import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Popover, ScrollArea, Stack, TextInput } from '@mantine/core';
import { CaretGlyph, FolderHitList, FolderTreePicker } from './FolderTreePicker';
import { allFolders, ancestorIdsOf, pathTitlesOf, type FolderTreeNode } from './folderTree';

/** A search that lands on too many rows to read is not helping; the tree is
 * still one scroll away. */
const HIT_LIMIT = 50;

export interface FolderPickerFieldProps {
  tree: FolderTreeNode[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  description?: string;
  placeholder?: string;
  /** The read that fills the tree is still running. */
  loading?: boolean;
  /** The folder already in effect. The layer opens with its parents already
   * open, because the first thing a reader wants to know is where the current
   * one sits. */
  revealId?: string;
  /** Groups this field's radios with its own rows and nobody else's. */
  groupName?: string;
}

/**
 * A folder chosen from a tree, in a layer that only exists while it is open.
 *
 * Neither surface has room for a bookmark tree laid out inline: a real bar is
 * dozens of folders deep, and a box tall enough to show one would push
 * everything else off the screen. The layer carries its own search, because a
 * reader who knows the folder's name should not have to guess which five rows
 * to open to reach it.
 */
export function FolderPickerField({
  tree,
  value,
  onChange,
  label,
  description,
  placeholder = '选择一个文件夹',
  loading = false,
  revealId,
  groupName = 'pontis-folder',
}: FolderPickerFieldProps) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // "Nothing here yet" is a claim about the account or the browser, so it waits
  // for the read to come back; while it runs the field says what it is doing.
  const empty = !loading && tree.length === 0;
  const chosen = pathTitlesOf(tree, value);

  useEffect(() => {
    const reveal = value || revealId || '';
    if (!open || !reveal) return;
    setExpanded((current) => new Set([...current, ...ancestorIdsOf(tree, reveal)]));
  }, [open, value, revealId, tree]);

  const hits = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    return allFolders(tree)
      .filter((node) => node.title.toLocaleLowerCase().includes(needle))
      .slice(0, HIT_LIMIT)
      .map((node) => ({ node, trail: (pathTitlesOf(tree, node.id) ?? []).slice(0, -1) }));
  }, [tree, query]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The click that opened the layer landed on the read-only field, so the
  // focus trap left it there and a reader who started typing at once typed
  // into nothing. Take the caret to the search box on open.
  useEffect(() => {
    if (!open) return;
    // The click that opened the layer left the caret in the read-only field,
    // and whatever settles focus after that lands in the same frame this does,
    // so the hand-off waits for a paint rather than a timer.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => searchRef.current?.focus());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <Popover
      opened={open}
      onChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
      width="target"
      position="bottom-start"
      shadow="md"
      withArrow
      arrowOffset={10}
    >
      <Popover.Target>
        <TextInput
          label={label}
          aria-label={label ?? placeholder}
          description={description}
          readOnly
          value={chosen ? chosen.join(' / ') : ''}
          placeholder={loading ? '正在读取目录……' : empty ? '没有可选的文件夹' : placeholder}
          disabled={loading || empty}
          styles={{ input: { cursor: 'pointer' } }}
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-haspopup="true"
          rightSection={
            <Box className="pontis-fieldToggle" data-open={open || undefined}>
              <CaretGlyph />
            </Box>
          }
          rightSectionWidth={30}
        />
      </Popover.Target>

      <Popover.Dropdown>
        <Stack gap={4}>
          <TextInput
            size="xs"
            placeholder="搜索文件夹"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            ref={searchRef}
          />
          <ScrollArea.Autosize mah={260} type="auto" offsetScrollbars>
            <Box py={4}>
              {query.trim() ? (
                hits.length > 0 ? (
                  <FolderHitList hits={hits} picked={value} onPick={pick} groupName={groupName} />
                ) : (
                  <Box px="sm" py={6} fz="xs" c="dimmed">
                    没有名字匹配的文件夹
                  </Box>
                )
              ) : (
                <FolderTreePicker
                  nodes={tree}
                  picked={value}
                  onPick={pick}
                  groupName={groupName}
                  expanded={expanded}
                  onToggle={toggle}
                />
              )}
            </Box>
          </ScrollArea.Autosize>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
