param([Parameter(Mandatory=$true)][ValidatePattern('^COM[0-9]+$')][string]$PortName)
$ErrorActionPreference = 'Stop'
$serialPort = New-Object System.IO.Ports.SerialPort $PortName,115200,None,8,one
$serialPort.DtrEnable = $false
$serialPort.RtsEnable = $false
$serialPort.WriteTimeout = 3000
$serialPort.ReadTimeout = 5000
$serialPort.NewLine = "`n"
try {
    $serialPort.Open()
    Start-Sleep -Seconds 2
    $serialPort.DiscardInBuffer()
    [Console]::WriteLine('READY')
    while ($null -ne ($relayLine = [Console]::ReadLine())) {
        if ($relayLine -notmatch '^(SUMMARY [0-9]+ [0-9]+|ERROR|TEST)$') { throw 'Invalid command' }
        $serialPort.WriteLine($relayLine)
        if ($relayLine -ne 'ERROR') {
            $expectedReply = if ($relayLine -eq 'TEST') { 'TEST OK' } else { 'OK' }
            $replyDeadline = [DateTime]::UtcNow.AddSeconds(6)
            do {
                $deviceReply = $serialPort.ReadLine().Trim()
                if ([DateTime]::UtcNow -gt $replyDeadline) { throw 'Device acknowledgement timeout' }
            } while ($deviceReply -ne $expectedReply)
            [Console]::WriteLine('ACK')
        }
    }
} catch {
    $usbFailure = $_.Exception.GetBaseException().Message -replace '[\r\n]+', ' '
    [Console]::WriteLine('USB_ERROR: ' + $usbFailure)
    exit 1
} finally {
    if ($serialPort.IsOpen) { $serialPort.Close() }
    $serialPort.Dispose()
}
