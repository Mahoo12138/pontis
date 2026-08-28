import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Skeleton } from '@mantine/core';
import Header from '../components/app-shell/Header';
import Toolbar from '../components/app-shell/Toolbar';
import BookmarkExplorer from '../components/explorer/BookmarkExplorer';
import {
  headerRegion,
  toolbarRegion,
  contentRegion,
} from '../styles/app-shell.css';

export default function SpaceExplorerPage() {
  const { spaceId } = useParams();
  const [filter, setFilter] = useState<'all' | 'folders' | 'bookmarks'>('all');

  return (
    <>
      <Header breadcrumb="个人 / 开发" />
      <Toolbar filter={filter} onFilterChange={setFilter} />
      <div className={contentRegion}>
        <BookmarkExplorer spaceId={spaceId} filter={filter} />
      </div>
    </>
  );
}
