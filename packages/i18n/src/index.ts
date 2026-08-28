import commonZhCn from './zh-CN/common.json';
import authZhCn from './zh-CN/auth.json';
import explorerZhCn from './zh-CN/explorer.json';
import sidebarZhCn from './zh-CN/sidebar.json';

import commonEn from './en/common.json';
import authEn from './en/auth.json';
import explorerEn from './en/explorer.json';
import sidebarEn from './en/sidebar.json';

export const zhCN = {
  common: commonZhCn,
  auth: authZhCn,
  explorer: explorerZhCn,
  sidebar: sidebarZhCn,
};

export const en = {
  common: commonEn,
  auth: authEn,
  explorer: explorerEn,
  sidebar: sidebarEn,
};

export type I18nResources = typeof zhCN;
