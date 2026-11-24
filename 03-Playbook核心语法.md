# 第 3 篇 · Playbook 核心语法（重点篇）

> Playbook 是 Ansible 的主力武器。本篇按"结构 → 模块 → 变量 → 触发 → 条件 → 循环 → 调试"的顺序讲透核心语法，最后用一个完整的 Nginx 部署示例把所有知识点串起来。

---

## 一、Playbook 的解剖

Playbook = 一个 YAML 文件，顶层是**一个或多个 play**，每个 play 描述"对哪批机器、以什么身份、做哪些事"：

```yaml
---
- name: 在 web 组部署 Nginx          # ① play 的名字（强烈建议写）
  hosts: web                          # ② 目标：inventory 里的组/主机名/模式(all/web:db)
  become: true                        # ③ 用 root 执行(等价 ad-hoc 的 -b)
  vars:                               # ④ play 级变量
    http_port: 80
  tasks:                              # ⑤ 任务列表：从上到下顺序执行
    - name: 安装 Nginx                # 每个任务 = 一个模块调用
      ansible.builtin.apt:            # 模块全名：集合.模块(内置可省略集合名)
        name: nginx
        state: present
      notify: 重启 Nginx              # 变化时触发 handler(见第四节)

    - name: 下发配置文件
      ansible.builtin.copy:
        src: files/nginx.conf         # 控制节点上的文件(相对 playbook 目录)
        dest: /etc/nginx/nginx.conf
        mode: "0644"
      notify: 重启 Nginx

  handlers:                           # ⑥ handler 区：被 notify 触发才执行
    - name: 重启 Nginx
      ansible.builtin.service:
        name: nginx
        state: restarted
```

执行与输出解读：

```bash
ansible-playbook nginx.yml

# PLAY [在 web 组部署 Nginx] ...
# TASK [Gathering Facts] ok: [node1]          ← 默认先采集机器信息
# TASK [安装 Nginx] changed: [node1]           ← changed=真的动了；ok=已是目标状态(幂等!)
# TASK [下发配置文件] changed: [node1]
# RUNNING HANDLER [重启 Nginx] changed: [node1] ← 有变化才触发
# PLAY RECAP: node1 : ok=3 changed=3 unreachable=0 failed=0   ← 总账
```

**RECAP 是排错第一现场**：`failed>0` 看哪个 TASK 红；`unreachable>0` 回去查 SSH。

## 二、常用模块清单（按用途背这一张表）

### 2.1 文件与内容

| 模块 | 用途 | 示例 |
| --- | --- | --- |
| `copy` | 推送**静态**文件到目标机 | `copy: { src: a.conf, dest: /etc/a.conf, mode: "0644" }` |
| `template` | 推送 **Jinja2 模板**（含变量渲染，第 4 篇） | `template: { src: a.conf.j2, dest: /etc/a.conf }` |
| `file` | 管**路径属性**：目录/软链/权限/删除 | `file: { path: /data/app, state: directory, mode: "0755" }` |
| `lineinfile` | **精确改一行**（改配置最常用） | `lineinfile: { path: /etc/ssh/sshd_config, regexp: '^#?Port ', line: 'Port 2222' }` |
| `blockinfile` | 插入/管理一段文本块 | 追加多行配置 |
| `fetch` | 把目标机文件**拉回**控制节点 | 收集日志/证书 |
| `stat` | 探测文件状态（配合 `when`） | `stat: { path: /opt/app/xxx }` → `.stat.exists` |
| `get_url` | 下载文件 | `get_url: { url: https://.../a.tgz, dest: /tmp/a.tgz, mode: "0644" }` |

### 2.2 软件与服务

| 模块 | 用途 | 示例 |
| --- | --- | --- |
| `apt` / `dnf` / `yum` | 包管理（Debian 系 / RHEL 系） | `apt: { name: mysql-server, state: present, update_cache: true }` |
| `package` | 跨发行版通用（按 os_family 自动选） | `package: { name: vim, state: present }` |
| `unarchive` | 解压 tar/zip（可选先解到指定目录） | `unarchive: { src: app.tgz, dest: /opt/app, remote_src: true }` |
| `pip` | Python 包 | `pip: { name: pymysql, executable: pip3 }` |
| `service` | 管服务（跨系统通用） | `service: { name: nginx, state: restarted, enabled: true }` |
| `systemd` | systemd 细粒度控制（daemon_reload 等） | `systemd: { name: app, state: restarted, daemon_reload: true }` |

`state` 语义记牢：`present`（装了就行）/ `latest`（每次升级到最新）/ `absent`（卸载/删除）；服务 `started`/`stopped`/`restarted`/`reloaded` + `enabled: true`（开机自启）。

### 2.3 用户与命令

| 模块 | 用途 | 示例 |
| --- | --- | --- |
| `user` / `group` | 建用户/组 | `user: { name: app, system: true, shell: /usr/sbin/nologin }` |
| `authorized_key` | 管目标机的公钥 | 批量下发运维公钥 |
| `command` | 执行命令（**不走 shell，不支持管道**，最幂等安全） | `command: systemctl is-active nginx` |
| `shell` | 执行命令（走 shell，支持管道/变量展开；仅必要时用） | `shell: "cat x.log | wc -l"` |
| `script` | 把控制节点上的脚本拷过去执行 | 一次性迁移脚本 |
| `debug` | 打印信息（万能调试） | `debug: { var: result }` 或 <code v-pre>msg: "xxx {{ var }}"</code> |
| `wait_for` | 等待条件（端口开/文件出现） | `wait_for: { port: 3306, timeout: 120 }` |

> **command vs shell**：能用 `command` 就别用 `shell`（少一层解释、更可控）。凡"重复执行的部署命令"，先想想有没有等价模块（装包用 apt、传文件用 copy、建目录用 file）——**模块永远比裸命令幂等**。

## 三、变量与 facts

### 3.1 变量从哪来（常见四层，优先级从低到高）

```yaml
# ① play 里
vars:
  app_port: 8080

# ② inventory 里（组/主机变量，见第 2 篇）
[web:vars]
app_port=8080

# ③ group_vars / host_vars 目录文件（推荐，第 4 篇）
# group_vars/web.yml 内容: app_port: 8080

# ④ 命令行 -e（最高优先级，临时覆盖）
# ansible-playbook site.yml -e "app_port=9090"
```

引用一律 <code v-pre>{{ app_port }}</code>（Jinja2 语法）。命名建议：加前缀防撞名，如 `mysql_root_password`。

### 3.2 facts：自动采集的机器信息

每个 play 默认先跑 `setup` 模块采集 facts（关掉：`gather_facts: false`）。常用：

| fact | 含义 |
| --- | --- |
| `ansible_hostname` / `ansible_fqdn` | 主机名 |
| `ansible_default_ipv4.address` | 默认网卡 IP（配集群互连地址神器） |
| `ansible_os_family` | Debian / RedHat（跨发行版分支判断） |
| `ansible_memtotal_mb` / `ansible_processor_vcpus` | 内存/核数（按机器规格调参数） |

先在 ad-hoc 里摸一遍：`ansible node1 -m setup | less`，或过滤：`ansible node1 -m setup -a "filter=ansible_default_ipv4*"`。

### 3.3 register：把任务结果存进变量

```yaml
tasks:
  - name: 检查服务状态
    ansible.builtin.command: systemctl is-active nginx
    register: svc                       # 结果存进 svc
    changed_when: false                 # 查询类命令不算"变化"(见 3.4)

  - name: 打印结果
    ansible.builtin.debug:
      msg: "状态={{ svc.stdout }} 返回码={{ svc.rc }} 是否失败={{ svc.failed }}"
```

register 结果常用字段：`stdout`、`stdout_lines`（按行列表）、`rc`、`failed`、`stat.exists`（stat 模块）。

### 3.4 幂等性补丁：changed_when / failed_when

命令类模块每次都会报 `changed`，会误触发 handler。用声明修正：

```yaml
- name: 查询版本
  ansible.builtin.command: mysql --version
  register: v
  changed_when: false                    # 这是查询,永远不算变化

- name: 校验版本输出
  ansible.builtin.command: /opt/app/verify.sh
  register: r
  failed_when: "'ERROR' in r.stdout"     # 自定义失败条件
```

## 四、handlers：变化才触发

上文的 `notify`/`handlers` 已演示。三条铁律：

1. **只有真的 changed 才触发**（ok 不触发）——这是"配置没改就不重启"的幂等精髓；
2. **同一 play 内多次 notify 同一个 handler，只执行一次**，且在**所有 task 结束后**统一执行；
3. handler 也可以写多个任务；用 `listen` 让多个任务共用一组 handler：

```yaml
  handlers:
    - name: 重启应用                    # 名字要唯一
      listen: "restart app"
      ansible.builtin.systemd:
        name: app
        state: restarted
        daemon_reload: true
```

## 五、条件执行 when

`when` 接一个 Jinja2 布尔表达式（**不需要** <code v-pre>{{ }}</code> 包裹）：

```yaml
- name: Debian 系才装这个包
  ansible.builtin.apt:
    name: mypkg
    state: present
  when: ansible_os_family == "Debian"

- name: 内存不足时告警退出
  ansible.builtin.debug:
    msg: "内存不足 2G，请扩配"
  when: ansible_memtotal_mb < 2048

- name: 变量存在才执行
  ansible.builtin.debug:
    msg: "{{ db_password }}"
  when: db_password is defined

- name: 多条件（and 写成列表；or 用括号）
  ansible.builtin.debug: { msg: "it is ubuntu 22" }
  when:
    - ansible_distribution == "Ubuntu"
    - ansible_distribution_version is version("22", ">=")

- name: 根据上一步结果分支
  ansible.builtin.debug: { msg: "目录已存在" }
  when: dir_check.stat.exists          # 配合 register/stat
```

## 六、循环 loop

```yaml
# 简单列表
- name: 安装一批软件
  ansible.builtin.apt:
    name: "{{ item }}"
    state: present
  loop:
    - curl
    - unzip
    - htop

# 字典列表（item.key 取字段）
- name: 建多个用户
  ansible.builtin.user:
    name: "{{ item.name }}"
    groups: "{{ item.groups }}"
  loop:
    - { name: deploy, groups: "sudo" }
    - { name: app, groups: "www-data" }

# 循环 + 条件组合（每个 item 都过一遍 when）
- name: 只处理需要启用的服务
  ansible.builtin.service:
    name: "{{ item.name }}"
    state: started
    enabled: "{{ item.enabled }}"
  loop:
    - { name: nginx, enabled: true }
    - { name: php-fpm, enabled: false }
  when: item.enabled | bool
  loop_control:
    label: "{{ item.name }}"           # 让日志只显示名字,不刷屏
```

老的 `with_items`/`with_lines` 写法已被 `loop` 取代，新代码统一用 `loop`。

## 七、block：任务组 + 失败兜底

```yaml
- block:
    - name: 部署新版本
      ansible.builtin.command: /opt/app/switch.sh
  rescue:                              # block 内任一失败则进这里
    - name: 回滚到旧版本
      ansible.builtin.command: /opt/app/rollback.sh
  always:                              # 无论成败都执行
    - name: 发通知
      ansible.builtin.debug: { msg: "部署流程结束" }
```

## 八、tags 与 --check

```yaml
tasks:
  - name: 安装软件
    ansible.builtin.apt: { name: nginx, state: present }
    tags: [install]
  - name: 下发配置
    ansible.builtin.template: { src: nginx.conf.j2, dest: /etc/nginx/nginx.conf }
    tags: [config, deploy]
```

```bash
ansible-playbook site.yml --tags config       # 只跑 config 步骤
ansible-playbook site.yml --skip-tags install # 跳过安装
ansible-playbook site.yml --check --diff      # 试运行:只报告会改什么,不真改(--diff 显示差异)
```

**`--check --diff` 是生产变更前必做的"彩排"**，配合 Git 管理 playbook 可实现真正的变更评审。

## 九、串联示例：完整的 Nginx 部署 Playbook

```yaml
---
- name: 部署 Nginx 站点
  hosts: web
  become: true
  vars:
    http_port: 80
    server_name: demo.example.com
    sites:
      - { name: app1, root: /var/www/app1 }
      - { name: app2, root: /var/www/app2 }
  tasks:
    - name: 安装 Nginx
      ansible.builtin.apt:
        name: nginx
        state: present
        update_cache: true
        cache_valid_time: 3600
      tags: install

    - name: 建站点根目录
      ansible.builtin.file:
        path: "{{ item.root }}"
        state: directory
        owner: www-data
        mode: "0755"
      loop: "{{ sites }}"
      loop_control: { label: "{{ item.name }}" }

    - name: 下发主配置（模板含变量）
      ansible.builtin.template:
        src: nginx.conf.j2
        dest: /etc/nginx/nginx.conf
        mode: "0644"
        validate: "nginx -t -c %s"          # 改完先校验语法,坏了不生效
      notify: 重启 Nginx

    - name: 确保 Nginx 运行且开机自启
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

    - name: 等待端口就绪
      ansible.builtin.wait_for:
        port: "{{ http_port }}"
        timeout: 30

    - name: 首页探活
      ansible.builtin.uri:
        url: "http://127.0.0.1:{{ http_port }}/"
        status_code: 200
      register: probe
      changed_when: false

  handlers:
    - name: 重启 Nginx
      ansible.builtin.service:
        name: nginx
        state: restarted
```

配套模板 `templates/nginx.conf.j2`（第 4 篇详解 Jinja2）：

```jinja
server {
    listen {{ http_port }};
    server_name {{ server_name }};
    {% for s in sites %}
    location /{{ s.name }}/ {
        root {{ s.root }};
    }
    {% endfor %}
}
```

## 十、小结

- Playbook 三层骨架：**play（目标/变量）→ tasks（模块调用）→ handlers（变化触发）**；
- 模块优先于裸命令；`command` 优先于 `shell`；`changed_when`/`failed_when` 是幂等性补丁；
- 变量四来源：play `vars` → inventory → `group_vars/host_vars` → `-e` 命令行；facts 免费提供机器信息；
- `when` 写条件、`loop` 写循环、`block/rescue` 写兜底、`tags` 挑步骤、`--check --diff` 彩排；
- 每个任务都写 `name`，RECAP 是排错第一现场。

下一篇把"散装任务"升级成标准化的 Role 工程结构，并学会模板、集合与密钥管理。

---

*导航：[README](README.md) · 上一篇：[02-安装与连通](02-安装与连通.md) · 下一篇：[04-Roles与工程化](04-Roles与工程化.md)*
