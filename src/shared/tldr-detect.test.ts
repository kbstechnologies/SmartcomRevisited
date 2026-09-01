import { describe, expect, it } from 'vitest'
import {
  baseCommandOfSegment,
  basename,
  classifyCommand,
  detectCommand,
  splitSegments,
  tokenise,
} from './tldr-detect'

describe('tokenise', () => {
  it('keeps a quoted region as one token', () => {
    expect(tokenise('grep "foo | bar" file')).toEqual(['grep', 'foo | bar', 'file'])
  })

  it('handles escaped spaces', () => {
    expect(tokenise('cat /var/log/my\\ file.log')).toEqual(['cat', '/var/log/my file.log'])
  })

  it('keeps an empty quoted argument', () => {
    expect(tokenise("sed 's/a//' ''")).toEqual(['sed', 's/a//', ''])
  })
})

describe('splitSegments', () => {
  it('splits pipelines and chains', () => {
    expect(splitSegments('grep foo /var/log/messages | tail -20')).toEqual([
      'grep foo /var/log/messages',
      'tail -20',
    ])
    expect(splitSegments('cd /tmp && ls -l')).toEqual(['cd /tmp', 'ls -l'])
    expect(splitSegments('a || b')).toEqual(['a', 'b'])
    expect(splitSegments('a; b')).toEqual(['a', 'b'])
  })

  it('does not split on a separator inside quotes', () => {
    expect(splitSegments('echo "a | b"')).toEqual(['echo "a | b"'])
  })

  it('leaves a trailing background ampersand alone', () => {
    expect(splitSegments('tcpdump -i eth0 &')).toEqual(['tcpdump -i eth0 &'])
  })
})

describe('basename', () => {
  it('strips paths and Windows extensions', () => {
    expect(basename('/usr/bin/tcpdump')).toBe('tcpdump')
    expect(basename('./backup.sh')).toBe('backup.sh')
    expect(basename('C:\\Windows\\System32\\ipconfig.exe')).toBe('ipconfig')
  })
})

describe('baseCommandOfSegment', () => {
  it('steps over environment assignments', () => {
    expect(baseCommandOfSegment('LANG=C DEBUG=1 grep foo')).toBe('grep')
  })

  it('refuses to name a redirect or a subshell', () => {
    expect(baseCommandOfSegment('> /tmp/out')).toBe('')
    expect(baseCommandOfSegment('')).toBe('')
  })
})

describe('detectCommand', () => {
  // These are the cases the feature is judged on: the first word is almost
  // never the command anyone wants documentation for.
  it.each([
    ['tcpdump -i eth0 port 5060', 'tcpdump'],
    ['sudo tcpdump -i eth0', 'tcpdump'],
    ['sudo -u root tcpdump -i eth0', 'tcpdump'],
    ['sudo --user=root tcpdump', 'tcpdump'],
    ['sudo -- rm -rf /tmp/x', 'rm'],
    ['sudo systemctl restart nginx', 'systemctl'],
    ['docker ps -a', 'docker'],
    ['ip route show', 'ip'],
    ['env FOO=bar curl https://example.com', 'curl'],
    ['nohup ./long-job.sh', 'long-job.sh'],
    ['time make -j8', 'make'],
    ['watch -n 5 kubectl get pods', 'kubectl'],
    ['/usr/bin/tcpdump -D', 'tcpdump'],
    ['timeout -k 5 30 ansible-playbook site.yml', 'ansible-playbook'],
    ['command ls -l', 'ls'],
  ])('%s → %s', (line, expected) => {
    expect(detectCommand(line).command).toBe(expected)
  })

  it('reports every command in a pipeline, primary first', () => {
    const detected = detectCommand('grep foo /var/log/messages | tail -20')
    expect(detected.command).toBe('grep')
    expect(detected.all).toEqual(['grep', 'tail'])
  })

  it('names the wrappers it stepped over', () => {
    expect(detectCommand('sudo -u root tcpdump').wrappers).toEqual(['sudo'])
  })

  it('is empty for an empty line', () => {
    expect(detectCommand('   ').command).toBe('')
    expect(detectCommand('').all).toEqual([])
  })

  it('does not spin on a line that is only wrappers', () => {
    expect(detectCommand('sudo sudo sudo sudo').command).toBe('')
  })
})

describe('classifyCommand', () => {
  it.each([
    'rm -rf /var/tmp/build',
    'sudo rm -r /opt/old',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sdb',
    'fdisk /dev/sda',
    'parted /dev/sda',
    'shutdown -h now',
    'sudo reboot',
    'poweroff',
    'iptables -F',
    'sudo ufw reset',
    'apt-get remove nginx',
    'dnf remove httpd',
    'pacman -R vim',
    'systemctl disable nginx',
    'docker system prune -a',
    'docker rm -f web',
    'kubectl delete pod web-1',
    'DROP DATABASE customers;',
    'DELETE FROM orders WHERE id = 1',
    'git reset --hard origin/main',
    'git push --force',
    'crontab -r',
    'chmod -R 777 /srv',
    'Remove-Item -Recurse -Force C:\\temp',
    'write erase',
    'no ip route 0.0.0.0 0.0.0.0',
  ])('flags %s', (command) => {
    const risk = classifyCommand(command)
    expect(risk.destructive, command).toBe(true)
    expect(risk.reasons.length).toBeGreaterThan(0)
  })

  it.each([
    'ls -la',
    'tcpdump -i eth0 port 5060',
    'systemctl status nginx',
    'docker ps -a',
    'ip route show',
    'grep foo /var/log/messages',
    'git status',
    'kubectl get pods',
    'rsync /home/user/files server:/backup',
    'show running-config',
    'apt-get install nginx',
  ])('leaves %s alone', (command) => {
    expect(classifyCommand(command).destructive, command).toBe(false)
  })

  it('classifies any segment of a pipeline, not only the first', () => {
    expect(classifyCommand('find /tmp -name "*.log" | xargs rm -f').destructive).toBe(true)
  })

  it('says nothing about an empty command', () => {
    expect(classifyCommand('   ')).toEqual({ destructive: false, reasons: [] })
  })
})
