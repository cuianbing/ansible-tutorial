import { defineConfig } from 'vitepress'

// GitHub Pages 部署在 https://<user>.github.io/ansible-tutorial/ 下，需要 base 前缀；
// Netlify / 本地开发部署在根路径，base 为 '/'。
const base = process.env.GITHUB_ACTIONS === 'true' ? '/ansible-tutorial/' : '/'

export default defineConfig({
  base,
  title: 'Ansible 从零到一',
  description: '面向纯小白的运维自动化系列教程：从概念到 Playbook 工程化，再到 4 个中间件部署实操案例',
  lang: 'zh-CN',
  lastUpdated: true,
  cleanUrls: true,

  // 源码直接放在仓库根目录，排除非教程内容
  srcExclude: ['node_modules/**', '.github/**', '.vitepress/cache/**', '.vitepress/dist/**'],

  head: [
    ['meta', { name: 'keywords', content: 'Ansible,运维自动化,Playbook,Roles,MySQL,ZooKeeper,Elasticsearch' }]
  ],

  themeConfig: {
    logo: '📖',
    siteTitle: 'Ansible 从零到一',

    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/01-初识Ansible' },
      {
        text: '实操案例',
        items: [
          { text: '单机 MySQL', link: '/05-实操案例-单机MySQL' },
          { text: 'MySQL 主从读写分离', link: '/06-实操案例-MySQL主从读写分离' },
          { text: 'ZooKeeper 三节点集群', link: '/07-实操案例-ZooKeeper三节点集群' },
          { text: 'Elasticsearch 三节点集群', link: '/08-实操案例-Elasticsearch三节点集群' }
        ]
      },
      { text: 'GitHub', link: 'https://github.com/cuianbing/ansible-tutorial' }
    ],

    sidebar: [
      {
        text: '基础篇',
        items: [
          { text: '01 · 初识 Ansible', link: '/01-初识Ansible' },
          { text: '02 · 安装与连通', link: '/02-安装与连通' }
        ]
      },
      {
        text: '核心篇',
        items: [
          { text: '03 · Playbook 核心语法', link: '/03-Playbook核心语法' },
          { text: '04 · Roles 与工程化', link: '/04-Roles与工程化' }
        ]
      },
      {
        text: '实操案例',
        items: [
          { text: '05 · 单机 MySQL', link: '/05-实操案例-单机MySQL' },
          { text: '06 · MySQL 主从读写分离', link: '/06-实操案例-MySQL主从读写分离' },
          { text: '07 · ZooKeeper 三节点集群', link: '/07-实操案例-ZooKeeper三节点集群' },
          { text: '08 · Elasticsearch 三节点集群', link: '/08-实操案例-Elasticsearch三节点集群' }
        ]
      }
    ],

    outline: {
      label: '本页目录',
      level: [2, 3]
    },

    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },

    lastUpdated: {
      text: '最后更新',
      formatOptions: { dateStyle: 'short', timeStyle: 'short' }
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
          }
        }
      }
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',

    socialLinks: [
      { icon: 'github', link: 'https://github.com/cuianbing/ansible-tutorial' }
    ],

    footer: {
      message: '基于 MIT 许可发布',
      copyright: 'Copyright © 2026 cuianbing'
    },

    editLink: {
      pattern: 'https://github.com/cuianbing/ansible-tutorial/edit/main/:path',
      text: '在 GitHub 上编辑此页'
    }
  }
})
