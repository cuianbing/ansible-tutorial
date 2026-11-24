# 第 8 篇 · 实操案例：Elasticsearch 三节点集群

> **目标**：三台 Ubuntu 一键部署 **Elasticsearch 9.x 三节点集群**（apt 源安装、内核参数、discovery 配置、JVM 堆、健康校验）。本篇是系列的收尾，也把前几篇的套路做一个总结。

---

## 一、ES 是什么与集群拓扑

Elasticsearch（ES）是分布式搜索/分析引擎（倒排索引 + Lucene），日志平台（ELK）的核心。集群要素：

- **节点角色**：本篇让 3 台**既当 master 候选又当 data 节点**（小规模标准做法）；大规模再拆分专职角色；
- **主节点选举**：master 候选数应为**奇数**（3 台容忍 1 台主节点故障），靠 `discovery.seed_hosts` 互相发现；
- **数据冗余**：索引的每个分片有主/副本两份，分布在不同节点上——3 台是"高可用"的最低配置；
- **端口**：`9200` HTTP（客户端/管理）、`9300` 传输（节点间通信）。

两个前置硬性要求（缺一启动必失败）：

1. 内核参数 `vm.max_map_count >= 262144`（Lucene mmap 需要）；
2. **JVM 堆 ≤ 机器内存的一半**且 Xms=Xmx（用 2C4G 机器就堆 2G；内存不足 4G 请先升配）。

> ⚠️ **安全提示**：ES 8/9 默认开启安全特性（TLS + 认证）。为让 Ansible 流程对小白可复现，本篇学习集群**显式关闭安全**（`xpack.security.enabled: false`），**必须只在内网隔离环境使用**；生产环境请按官方文档开启 TLS 与密码认证。

## 二、环境准备

inventory：

```ini
[es]
es1 ansible_host=192.168.100.11 ansible_user=deploy
es2 ansible_host=192.168.100.12 ansible_user=deploy
es3 ansible_host=192.168.100.13 ansible_user=deploy
```

变量文件 `vars/es.yml`：

```yaml
es_version: "9.5.6"                       # 可换成 8.19.x/9.x 其他小版本,三台必须一致!
es_cluster_name: learning-es
es_heap: "2g"                             # 必须 ≤ 机器内存的一半
es_repo: "9.x"                            # apt 大版本分支:9.x 或 8.x
```

> 三台版本号**必须完全一致**（ES 集群对版本一致性要求严格）；用变量统一控制是 Ansible 的天然优势。

## 三、模板

`templates/elasticsearch.yml.j2`：

```yaml
cluster.name: {{ es_cluster_name }}
node.name: {{ inventory_hostname }}              # 直接用 inventory 别名当节点名

# 监听:内网开放 HTTP(9200) 与节点间(9300)
network.host: 0.0.0.0
http.port: 9200

# 节点发现:列出全部 es 组成员 IP
discovery.seed_hosts:
{% for host in groups['es'] %}
  - {{ hostvars[host]['ansible_host'] }}
{% endfor %}

# 首次组网时的主节点候选名单(仅首次启动有效)
cluster.initial_master_nodes:
{% for host in groups['es'] %}
  - {{ hostvars[host]['ansible_host'] }}
{% endfor %}

# 学习集群:关闭安全特性 —— 只允许内网使用!
xpack.security.enabled: false
```

`templates/heap.options.j2`（ES 会合并读取 `jvm.options.d/` 下的文件）：

```text
-Xms{{ es_heap }}
-Xmx{{ es_heap }}
```

## 四、Playbook 全文

`elasticsearch-cluster.yml`：

```yaml
---
- name: 部署 Elasticsearch 三节点集群
  hosts: es
  become: true
  vars_files: [vars/es.yml]

  tasks:
    # ---------- 1. 系统前置 ----------
    - name: 内核参数 vm.max_map_count(ES 硬性要求)
      ansible.builtin.sysctl:
        name: vm.max_map_count
        value: "262144"
        sysctl_file: /etc/sysctl.d/99-elasticsearch.conf
        reload: true

    - name: 安装 apt 基础工具
      ansible.builtin.apt:
        name: [apt-transport-https, ca-certificates, gnupg]
        state: present
        update_cache: true

    # ---------- 2. 配置官方 apt 源 ----------
    - name: 下载 Elastic GPG 公钥
      ansible.builtin.get_url:
        url: https://artifacts.elastic.co/GPG-KEY-elasticsearch
        dest: /tmp/elasticsearch.asc
        mode: "0644"
      register: gpg_key

    - name: 转换为 keyring 格式
      ansible.builtin.command: >
        gpg --dearmor -o /usr/share/keyrings/elasticsearch-keyring.gpg /tmp/elasticsearch.asc
      args:
        creates: /usr/share/keyrings/elasticsearch-keyring.gpg   # 已存在则跳过 → 幂等

    - name: 添加 ES apt 仓库
      ansible.builtin.apt_repository:
        repo: "deb [signed-by=/usr/share/keyrings/elasticsearch-keyring.gpg] https://artifacts.elastic.co/packages/{{ es_repo }}/apt stable main"
        state: present
        filename: elasticsearch

    # ---------- 3. 安装指定版本 ----------
    - name: 安装 Elasticsearch(锁版本)
      ansible.builtin.apt:
        name: "elasticsearch={{ es_version }}"
        state: present
        allow_change_held_packages: false

    # ---------- 4. 集群配置 ----------
    - name: 下发 elasticsearch.yml
      ansible.builtin.template:
        src: templates/elasticsearch.yml.j2
        dest: /etc/elasticsearch/elasticsearch.yml
        owner: root
        group: elasticsearch
        mode: "0660"
        backup: true
      notify: 重启 Elasticsearch

    - name: 下发 JVM 堆配置
      ansible.builtin.template:
        src: templates/heap.options.j2
        dest: /etc/elasticsearch/jvm.options.d/heap.options
        owner: root
        group: elasticsearch
        mode: "0660"
      notify: 重启 Elasticsearch

    # ---------- 5. 启动 ----------
    - name: 启动并设置开机自启
      ansible.builtin.systemd:
        name: elasticsearch
        state: started
        enabled: true

    - name: 等待 HTTP 9200 就绪
      ansible.builtin.wait_for:
        port: 9200
        timeout: 300              # ES 启动较慢,超时放宽

    - name: 等待集群健康(至多等 yellow:无副本分片也放行)
      ansible.builtin.uri:
        url: "http://127.0.0.1:9200/_cluster/health?wait_for_status=yellow&timeout=60s"
        status_code: 200
      register: health
      changed_when: false
      retries: 6
      delay: 10
      until: health.status == 200

    - name: 打印集群健康摘要
      ansible.builtin.debug:
        msg: "{{ inventory_hostname }} → 状态={{ health.json.status }} 节点数={{ health.json.number_of_nodes }}"

  handlers:
    - name: 重启 Elasticsearch
      ansible.builtin.systemd:
        name: elasticsearch
        state: restarted
```

> `uri` 模块的 `retries/until` 是"轮询等待"标准写法：ES 启动要几十秒，第一次请求可能连接拒绝，重试直到返回 200。

## 五、执行与验证

```bash
cd ~/ansible-demo
ansible-playbook elasticsearch-cluster.yml
# 期望:三台全绿,健康摘要 状态=green(或首次为 yellow) 节点数=3
```

**验证 1：集群健康与节点列表**：

```bash
curl -s http://192.168.100.11:9200/_cluster/health?pretty
curl -s http://192.168.100.11:9200/_cat/nodes?v
# 期望:3 行节点,其中一列 master 为 *(当前主节点)
```

**验证 2：数据冗余**——任一节点建索引，分片应分布到多个节点：

```bash
curl -X PUT http://192.168.100.12:9200/books
curl -s http://192.168.100.11:9200/_cat/shards/books?v
# 期望:books 0 p 与 books 0 r 落在不同节点(p=主分片 r=副本)
```

健康状态解读（排障必备）：

| 状态 | 含义 | 动作 |
| --- | --- | --- |
| `green` | 所有分片（含副本）就绪 | 无 |
| `yellow` | 主分片就绪，**副本分片未分配** | 集群可用但冗余缺失：节点数不够/磁盘水位报警 |
| `red` | 存在丢失的主分片 | 数据不可用风险，立刻查 `/_cat/shards` 与节点日志 |

## 六、常见问题（FAQ）

| 现象 | 原因与处理 |
| --- | --- |
| 启动失败 `max virtual memory areas ... too low` | `vm.max_map_count` 没生效：`sysctl vm.max_map_count` 复查；容器环境需在宿主机/容器参数层面设置 |
| `master not discovered` 反复刷日志 | 节点间 9300 不通（防火墙）或 `discovery.seed_hosts` IP 写错；`telnet 192.168.100.12 9300` 验证 |
| 健康长期 `yellow` | 只有 1 台活着（副本无处安放）或磁盘使用率超 85%（ES 水位保护） |
| OOM / 被系统杀 | 堆超机器一半，或机器内存太小：调小 `es_heap` 或升配 |
| `failed to bind to [9200]` | 端口被占（同机跑过单机 ES）；`ss -lntp | grep 9200` |
| 版本混装组不了集群 | 三台必须同版本；检查 `apt` 是否锁了 <code v-pre>={{ es_version }}</code> |
| 重复执行 playbook 时卡在等待健康 | 处理器正在滚动重启中；多等几分钟；确认不是改了 `es_version` |
| 想开启安全特性 | 设 `xpack.security.enabled: true` 后按官方文档走 TLS 证书与初始密码流程（超出本篇范围），并把 9200 从公网隔离 |

## 七、系列总结：四个案例的通用套路

至此四个中间件案例完成，把可迁移的"套路"提炼成一张表，部署任何中间件都能照此组装：

| 套路 | 对应案例 | 关键技术点 |
| --- | --- | --- |
| 装包型（走系统包管理器） | MySQL、ES | `apt` + 官方源 + 版本锁定；模块化初始化（建库/建账号） |
| 解压型（tar 包自管） | ZooKeeper | `stat+when` 缓存下载、`unarchive`、版本软链、专用用户 |
| 集群互发现 | ZK、ES | `groups['组名']` + `hostvars` 模板生成成员清单；`myid`/`server.N`/`seed_hosts` |
| 配置幂等 | 全部 | 独立配置文件 + `notify` handler + `--check --diff` 彩排 |
| 服务托管 | ZK | 自造 systemd 单元（`start-foreground`）+ `Restart=always` |
| 状态校验 | MySQL/ES | `assert`/`uri until` 把"成功"写进流水线，失败当场暴露 |

**后续扩展方向**（照此思路自练）：Redis 单机/哨兵（apt + template）、Kafka（复用 ZK 套路 + KRaft）、Nginx 反代集群（copy + handler）、Docker 化部署（`community.docker` 集合）。

**团队落地三步**：① 把案例改造成 Role（第 4 篇）纳入 Git；② 密码全部 Vault 化；③ 接入 CI（GitHub Actions 系列教程的流水线里跑 `ansible-playbook --check` 做变更彩排）。

---

*导航：[README](README.md) · 上一篇：[07-实操案例-ZooKeeper三节点集群](07-实操案例-ZooKeeper三节点集群.md) · 回到：[系列目录](README.md)*
